import { createRoute } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';
import { ApiKeysPage } from '../../pages/ApiKeysPage';

export const Route = createRoute({
  path: '/api-keys',
  getParentRoute: () => appRoute,
  component: ApiKeysPage,
});
