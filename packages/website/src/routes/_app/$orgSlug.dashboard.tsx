import { createRoute } from '@tanstack/react-router';
import { Route as orgSlugRoute } from './$orgSlug';
import { DashboardPage } from '../../pages/DashboardPage';

export const Route = createRoute({
  path: '/dashboard',
  getParentRoute: () => orgSlugRoute,
  component: DashboardPage,
});
