import { createRoute } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';
import { MembersPage } from '../../pages/MembersPage';
import { RequirePermissionPage } from '../../components/RequirePermissionPage';

function MembersRoute() {
  return (
    <RequirePermissionPage
      permission="members.read"
      title="Members"
      deniedMessage="Reading this organization's members is not part of your role."
    >
      <MembersPage />
    </RequirePermissionPage>
  );
}

export const Route = createRoute({
  path: '/members',
  getParentRoute: () => appRoute,
  component: MembersRoute,
});
