import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrgRole, ApiErrorCode, ROLE_PERMISSIONS, PERMISSIONS } from '@filone/shared';
import type { Permission } from '@filone/shared';
import {
  authorize,
  requireMembership,
  requireOrgMembershipMiddleware,
  requirePermission,
} from './authorize.js';
import { buildEvent, buildMiddyRequest, NO_MEMBERSHIP } from '../test/lambda-test-utilities.js';
import {
  expectErrorResponse,
  expectRefreshedCookies,
  REFRESHED_TOKENS,
} from '../test/assert-helpers.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import type { OrgMembership } from '../lib/org-membership.js';

const ORG_ID = 'org-1';
const USER_ID = 'user-1';

const NOT_A_MEMBER_BODY = {
  message: 'You are not a member of this organization.',
  code: ApiErrorCode.NOT_A_MEMBER,
};

const FORBIDDEN_BODY = {
  message: 'Your role in this organization does not permit this action.',
  code: ApiErrorCode.FORBIDDEN_ROLE,
};

function eventFor(membership?: { role: string }): AuthenticatedEvent {
  return buildEvent({
    userInfo: {
      userId: USER_ID,
      orgId: ORG_ID,
      // NO_MEMBERSHIP, not undefined: the fixture's default is an Owner, so a
      // caller with no row has to be named.
      membership: membership
        ? ({ orgId: ORG_ID, userId: USER_ID, ...membership } as OrgMembership)
        : NO_MEMBERSHIP,
    },
  });
}

/** What a chain missing `authMiddleware` hands the gate: an event with no userInfo. */
function unauthenticatedEvent(): AuthenticatedEvent {
  return buildEvent() as unknown as AuthenticatedEvent;
}

function runAuthorize(permission: Permission, event: AuthenticatedEvent) {
  return authorize(permission).before(buildMiddyRequest(event));
}

describe('authorize', () => {
  const written: string[] = [];

  beforeEach(() => {
    // reportMetric writes EMF straight to stdout; capture rather than print it.
    written.length = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(chunk.toString());
      return true;
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function emittedMetrics(): Record<string, unknown>[] {
    return written.map((line) => JSON.parse(line));
  }

  describe('membership', () => {
    it('refuses a caller with no membership row', () => {
      const result = runAuthorize('buckets.read', eventFor());

      expectErrorResponse(result, 403, NOT_A_MEMBER_BODY);
    });

    it('counts the denial so an unconverted account is visible as a metric', () => {
      runAuthorize('buckets.read', eventFor());

      expect(emittedMetrics()).toStrictEqual([
        {
          _aws: {
            Timestamp: expect.any(Number),
            CloudWatchMetrics: [
              {
                Namespace: 'FilOne',
                Dimensions: [['route']],
                Metrics: [{ Name: 'NotAMemberDenialCount', Unit: 'Count' }],
              },
            ],
          },
          route: 'GET /test',
          NotAMemberDenialCount: 1,
        },
      ]);
    });

    it('emits nothing on an ordinary role denial — only a lockout is newsworthy', () => {
      runAuthorize('buckets.delete', eventFor({ role: OrgRole.Member }));

      expect(emittedMetrics()).toStrictEqual([]);
    });

    it('passes a member holding the permission', () => {
      expect(runAuthorize('buckets.read', eventFor({ role: OrgRole.ReadOnly }))).toBeUndefined();
    });

    it('refuses a row whose role is not one of the four', () => {
      // A membership row is a DynamoDB string: whatever a bad write or a
      // half-finished conversion leaves in that column has to deny rather than
      // resolve to somebody's permission set. (The legacy value itself is
      // `admin`, which is a real role — what keeps pre-conversion rows out of
      // this gate is that they live in UserInfoTable, which `resolveMembership`
      // never reads.)
      const result = runAuthorize('buckets.read', eventFor({ role: 'billing' }));

      expectErrorResponse(result, 403, FORBIDDEN_BODY);
    });
  });

  describe('the capability matrix, as installed', () => {
    it.each([
      [OrgRole.ReadOnly, 'buckets.create'],
      [OrgRole.ReadOnly, 'objects.write'],
      [OrgRole.ReadOnly, 'objects.delete'],
      [OrgRole.ReadOnly, 'keys.create'],
      [OrgRole.Member, 'buckets.delete'],
      [OrgRole.Member, 'keys.manage_all'],
      [OrgRole.Member, 'billing.view'],
      [OrgRole.Member, 'org.rename'],
      [OrgRole.Admin, 'billing.manage'],
      [OrgRole.Admin, 'owners.manage'],
      [OrgRole.Admin, 'org.delete'],
    ] as const)('refuses %s on %s', (role, permission) => {
      expectErrorResponse(runAuthorize(permission, eventFor({ role })), 403, FORBIDDEN_BODY);
    });

    it('lets an Owner through every permission in the registry', () => {
      const refused = PERMISSIONS.filter(
        (permission) => runAuthorize(permission, eventFor({ role: OrgRole.Owner })) !== undefined,
      );
      expect(refused).toStrictEqual([]);
    });

    it('agrees with the registry for every role and permission', () => {
      // The middleware must be a projection of the table, not a second opinion.
      for (const role of Object.values(OrgRole)) {
        for (const permission of PERMISSIONS) {
          const allowed = runAuthorize(permission, eventFor({ role })) === undefined;
          expect([role, permission, allowed]).toStrictEqual([
            role,
            permission,
            ROLE_PERMISSIONS[role].includes(permission),
          ]);
        }
      }
    });
  });

  describe('requireMembership', () => {
    it('asks only that the caller is in the org', () => {
      expect(requireMembership(eventFor({ role: OrgRole.ReadOnly }))).toBeUndefined();
    });

    it('refuses an absent row', () => {
      expectErrorResponse(requireMembership(eventFor()), 403, NOT_A_MEMBER_BODY);
    });

    it('refuses a request that never met authMiddleware, rather than throwing', () => {
      // A chain assembled without the auth middleware has no caller to
      // authorize. A TypeError here would surface as a 500 and read as an
      // outage; the honest answer is the same 403 an unknown caller gets.
      const event = unauthenticatedEvent();

      expectErrorResponse(requireMembership(event), 403, NOT_A_MEMBER_BODY);
    });

    it('says the chain is miswired, and does not count it as a lockout', () => {
      const errors = vi.mocked(console.error);
      requireMembership(unauthenticatedEvent());

      expect(errors.mock.calls[0]?.[0]).toContain('missing authMiddleware');
      // NotAMemberDenialCount means "the conversion missed a cohort". A route
      // that was assembled wrong must not page the person reading that alarm.
      expect(emittedMetrics()).toStrictEqual([]);
    });

    it('counts a revoked key creator apart from an unconverted account', () => {
      // The runbook reads NotAMemberDenialCount as a lockout to investigate.
      // A key whose creator left the org is the design working as intended, so
      // it gets its own metric rather than inflating that one.
      const event = buildEvent({
        userInfo: {
          userId: USER_ID,
          orgId: ORG_ID,
          membership: NO_MEMBERSHIP,
          apiKeySession: true,
        },
      });

      expectErrorResponse(requireMembership(event), 403, NOT_A_MEMBER_BODY);
      expect(emittedMetrics()).toStrictEqual([
        {
          _aws: {
            Timestamp: expect.any(Number),
            CloudWatchMetrics: [
              {
                Namespace: 'FilOne',
                Dimensions: [['route']],
                Metrics: [{ Name: 'RevokedKeyCreatorDenialCount', Unit: 'Count' }],
              },
            ],
          },
          route: 'GET /test',
          RevokedKeyCreatorDenialCount: 1,
        },
      ]);
    });
  });

  describe('requireOrgMembershipMiddleware', () => {
    const run = (event: AuthenticatedEvent, internal?: Record<string, unknown>) =>
      requireOrgMembershipMiddleware().before(buildMiddyRequest(event, internal && { internal }));

    it('passes any member, whatever their role', () => {
      expect(run(eventFor({ role: OrgRole.ReadOnly }))).toBeUndefined();
    });

    it('refuses a caller with no membership row', () => {
      expectErrorResponse(run(eventFor()), 403, NOT_A_MEMBER_BODY);
    });

    it('carries the rotated cookies on its denial', () => {
      const result = run(eventFor(), { newTokens: REFRESHED_TOKENS });

      expectRefreshedCookies(result);
    });
  });

  describe('a denial after a token refresh', () => {
    it('carries the rotated cookies rather than logging the caller out', () => {
      // authMiddleware refreshed the session on this same request. Returning a
      // response here skips the after hook that would have set the cookies, so
      // the refused request would otherwise spend the old refresh token and
      // hand back nothing.
      const request = buildMiddyRequest(eventFor({ role: OrgRole.ReadOnly }), {
        internal: { newTokens: REFRESHED_TOKENS },
      });

      const result = authorize('buckets.delete').before(request);

      expect((result as { statusCode?: number })?.statusCode).toBe(403);
      expectRefreshedCookies(result);
    });

    it('does the same for a caller with no membership row', () => {
      const request = buildMiddyRequest(eventFor(), {
        internal: { newTokens: REFRESHED_TOKENS },
      });

      expectRefreshedCookies(authorize('buckets.read').before(request));
    });
  });

  describe('requirePermission', () => {
    it('names what was refused when the caller asks it to', () => {
      const result = requirePermission(
        eventFor({ role: OrgRole.ReadOnly }),
        'objects.delete',
        'Your role does not permit the requested operation: deleteObject.',
      );

      expectErrorResponse(result, 403, {
        message: 'Your role does not permit the requested operation: deleteObject.',
        code: ApiErrorCode.FORBIDDEN_ROLE,
      });
    });

    it('reports the absent row rather than the missing permission', () => {
      // Order matters for the console: "you were removed from this org" and
      // "your role cannot do this" are different states with different fixes.
      const result = requirePermission(eventFor(), 'objects.delete', 'named message');

      expectErrorResponse(result, 403, NOT_A_MEMBER_BODY);
    });
  });
});
