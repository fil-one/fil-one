import { createRoute, Outlet } from '@tanstack/react-router';
import { Route as rootRoute } from './__root';
import { AppShell } from '../components/AppShell';

export const Route = createRoute({
  id: 'app',
  getParentRoute: () => rootRoute,
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});
