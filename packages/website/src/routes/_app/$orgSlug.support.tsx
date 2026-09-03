import { createRoute } from '@tanstack/react-router';

import { Route as orgSlugRoute } from './$orgSlug';
import { SupportPage } from '../../pages/SupportPage';

export const Route = createRoute({
  path: '/support',
  getParentRoute: () => orgSlugRoute,
  component: SupportPage,
});
