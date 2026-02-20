import { createRoute, Outlet } from '@tanstack/react-router';
import { Route as rootRoute } from './__root';
import { AuthLayout } from '../components/AuthLayout';

export const Route = createRoute({
  id: 'auth',
  getParentRoute: () => rootRoute,
  component: () => (
    <AuthLayout>
      <Outlet />
    </AuthLayout>
  ),
});
