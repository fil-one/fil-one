import { createRoute } from '@tanstack/react-router';
import { Route as appRoute } from '../_app';
import { DashboardPage } from '../../pages/DashboardPage';

export const Route = createRoute({
  path: '/dashboard',
  getParentRoute: () => appRoute,
  component: DashboardPage,
});
