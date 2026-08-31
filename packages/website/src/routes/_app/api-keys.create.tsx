import { createRoute } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';
import { CreateApiKeyPage } from '../../pages/CreateApiKeyPage';
import { RequirePermissionPage } from '../../components/RequirePermissionPage';

function CreateApiKeyRoute() {
  return (
    <RequirePermissionPage
      permission="keys.create"
      title="Create access key"
      deniedMessage="Minting access keys is not part of your role. Ask a member who can create keys for one scoped to what you need."
    >
      <CreateApiKeyPage />
    </RequirePermissionPage>
  );
}

export const Route = createRoute({
  path: '/api-keys/create',
  getParentRoute: () => appRoute,
  component: CreateApiKeyRoute,
});
