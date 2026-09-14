import type { QueryClient } from '@tanstack/react-query';
import { OrgRole, ROLE_PERMISSIONS } from '@filone/shared';
import type { MeResponse } from '@filone/shared';
import { queryKeys } from './query-client.js';

/**
 * Seed the `/me` cache a permission-gated component reads, for a caller in this
 * role.
 *
 * Gated surfaces are hidden until `/me` answers, so a test that renders one
 * without seeding sees nothing and fails for the wrong reason. Seeding the
 * cache rather than mocking `usePermissions` keeps the real hook — and its
 * fail-closed reads — in the test.
 *
 * Owner by default, which is what every account holds today.
 */
export function seedPermissions(
  client: QueryClient,
  role: OrgRole = OrgRole.Owner,
  overrides: Partial<MeResponse> = {},
): void {
  const me: MeResponse = {
    orgId: 'org-1',
    orgName: 'Acme',
    slug: 'acme',
    nameConfirmed: true,
    emailVerified: true,
    email: 'user@example.com',
    mfaEnrollments: [],
    ragAccess: true,
    // On by default, like `ragAccess` above: a test about a gated surface should
    // not have to switch the feature on before it can render the thing it is
    // about. The surface tests override it.
    orgsBeta: true,
    userId: 'user-1',
    role,
    permissions: ROLE_PERMISSIONS[role],
    ...overrides,
  };
  client.setQueryData(queryKeys.me, me);
}
