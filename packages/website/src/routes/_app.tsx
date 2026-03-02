import { createRoute, Outlet, redirect } from '@tanstack/react-router';
import { Route as rootRoute } from './__root';
import { AppShell } from '../components/AppShell';

export const Route = createRoute({
  id: 'app',
  getParentRoute: () => rootRoute,
  beforeLoad: () => {
    if (!document.cookie.includes('hs_logged_in')) {
      throw redirect({ to: '/sign-in' });
    }
  },
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});
