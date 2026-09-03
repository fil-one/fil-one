import z from 'zod';
import { createRoute } from '@tanstack/react-router';

import { Route as orgSlugRoute } from './$orgSlug';
import { MembersPage, type MembersTabId } from '../../pages/MembersPage';
import { RequirePermissionPage } from '../../components/RequirePermissionPage';

/**
 * `tab` names which of the page's tabs opens, for links that mean a particular
 * one, e.g. `/organization?tab=invitations` now redirects here.
 */
const membersSearchSchema = z.object({
  tab: z.enum(['members', 'invitations']).optional(),
});

/**
 * `/members`, gated on the permission alone.
 *
 * `members.read` is held by every role, so the page renders for any org: a
 * one-person org sees a roster of itself, which is now the point rather than
 * something to hide behind a surface gate. Whether the caller can invite anyone
 * is a second question the page answers for itself (the Invitations tab and Add
 * member appear only for `members.manage`).
 *
 * Split from the route's own component so the gate can be exercised without a
 * router: it decides everything from `/me` and a tab name.
 */
export function MembersRoute() {
  const { tab } = Route.useSearch();
  return (
    <RequirePermissionPage
      permission="members.read"
      title="Members"
      deniedMessage="Reading this organization's members is not part of your role."
    >
      <MembersPage tab={tab as MembersTabId | undefined} />
    </RequirePermissionPage>
  );
}

export const Route = createRoute({
  path: '/members',
  getParentRoute: () => orgSlugRoute,
  component: MembersRoute,
  validateSearch: membersSearchSchema,
});
