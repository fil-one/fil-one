import { createRoute, Outlet, redirect } from '@tanstack/react-router';
import { Route as rootRoute } from './__root';
import { AuthLayout } from '../components/AuthLayout';

export const Route = createRoute({
  id: 'auth',
  getParentRoute: () => rootRoute,
  beforeLoad: () => {
    if (document.cookie.includes('hs_logged_in')) {
      throw redirect({ to: '/dashboard' });
    }
  },
  component: () => (
    <AuthLayout>
      <Outlet />
    </AuthLayout>
  ),
});
