import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { APIGatewayProxyResultV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiErrorCode, OrgRole, roleHasPermission } from '@filone/shared';
import type { Permission } from '@filone/shared';
import type { OrgMembership } from '../lib/org-membership.js';
import { membershipFor } from './lambda-test-utilities.js';

const ORG_ID = 'org-1';
const USER_ID = 'user-1';

/**
 * The denial cases a gated route owes its manifest entry, run against the
 * route's real Middy chain: every role the capability matrix refuses gets a
 * 403, and so does a caller with no membership row.
 *
 * Shared because the cases are the same shape on all of them and the route's
 * own test file should say which permission it is gated on, not re-derive the
 * matrix. What each role may do is `authorize`'s own test; that the declared
 * permission is the one installed is the manifest coverage test; this is the
 * route saying it in its own file, end to end.
 *
 * The refused roles are computed from the registry rather than listed, so a
 * matrix change shows up here instead of quietly narrowing the test. A
 * permission every role holds (`buckets.read`) has no refused roles and leaves
 * only the absent-row case, which is the honest thing for it to assert.
 */
export function describeRoleEnforcement({
  permission,
  invoke,
  orgId = ORG_ID,
  userId = USER_ID,
}: {
  permission: Permission;
  /** Run the route's full chain for a caller with this membership. */
  invoke: (membership: OrgMembership | undefined) => Promise<APIGatewayProxyResultV2>;
  orgId?: string;
  userId?: string;
}): void {
  const refused = Object.values(OrgRole).filter((role) => !roleHasPermission(role, permission));

  // Every route here answers with a ResponseBuilder, so the union's string arm
  // never occurs; middy's declared return type carries it anyway.
  const denial = async (membership: OrgMembership | undefined) =>
    (await invoke(membership)) as APIGatewayProxyStructuredResultV2;

  describe(`role enforcement (${permission})`, () => {
    beforeEach(() => {
      // The absent-row branch writes an EMF metric to stdout and logs the
      // denial; neither belongs in the test output.
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    if (refused.length > 0) {
      it.each(refused)('refuses %s', async (role) => {
        const result = await denial(membershipFor(orgId, userId, role));

        expect(result.statusCode).toBe(403);
        expect(JSON.parse(result.body ?? '{}').code).toBe(ApiErrorCode.FORBIDDEN_ROLE);
      });
    }

    it('refuses a caller with no membership row', async () => {
      const result = await denial(undefined);

      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body ?? '{}').code).toBe(ApiErrorCode.NOT_A_MEMBER);
    });
  });
}
