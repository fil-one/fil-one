import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrgRole, ApiErrorCode, ROLE_PERMISSIONS, PERMISSIONS } from '@filone/shared';
import type { Permission } from '@filone/shared';
import { authorize, requireMembership, requirePermission } from './authorize.js';
import { buildEvent, buildMiddyRequest } from '../test/lambda-test-utilities.js';
import { expectErrorResponse } from '../test/assert-helpers.js';
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
      // Explicitly undefined is how a caller with no row is spelled.
      membership: membership
        ? ({ orgId: ORG_ID, userId: USER_ID, ...membership } as OrgMembership)
        : undefined,
    },
  });
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
      // The value every pre-M1 row carried is deliberately not a role here: a
      // conversion that missed one must deny, not silently grant Admin's set.
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
