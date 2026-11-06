import z from 'zod';
import { createRoute } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';
import { OrganizationPage } from '../../pages/OrganizationPage';
import { RequirePermissionPage } from '../../components/RequirePermissionPage';

/**
 * `tab` names which of the page's tabs opens, for links that mean a particular
 * one, e.g. `/organization?tab=invitations` now redirects here.
 */
const membersSearchSchema = z.object({
  tab: z.enum(['members', 'invitations']).optional(),
});

function MembersRoute() {
  const { tab } = Route.useSearch();
  return (
    <RequirePermissionPage
      permission="members.read"
      title="Members"
      deniedMessage="Reading this organization's members is not part of your role."
    >
      <OrganizationPage tab={tab} />
    </RequirePermissionPage>
  );
}

export const Route = createRoute({
  path: '/members',
  getParentRoute: () => appRoute,
  component: MembersRoute,
  validateSearch: membersSearchSchema,
});
