import { createRoute } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';
import { CreateApiKeyPage } from '../../pages/CreateApiKeyPage';

export const Route = createRoute({
  path: '/api-keys/create',
  getParentRoute: () => appRoute,
  component: CreateApiKeyPage,
});
