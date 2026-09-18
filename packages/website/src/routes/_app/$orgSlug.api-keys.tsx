import { createRoute } from '@tanstack/react-router';

import { Route as orgSlugRoute } from './$orgSlug';
import { ApiKeysPage } from '../../pages/ApiKeysPage';

export const Route = createRoute({
  path: '/api-keys',
  getParentRoute: () => orgSlugRoute,
  component: ApiKeysPage,
});
