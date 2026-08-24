import { createRoute, Outlet, redirect } from '@tanstack/react-router';
import { Route as rootRoute } from './__root';

export const Route = createRoute({
  id: 'auth',
  getParentRoute: () => rootRoute,
  beforeLoad: () => {
    if (document.cookie.includes('hs_logged_in')) {
      throw redirect({ to: '/dashboard' });
    }
  },
  // No layout wrapper: sign-in/sign-up redirect to Auth0 before rendering, and
  // login-error now renders the standalone AuthCard. The two-column marketing
  // AuthLayout is retained in components/ but no longer used here.
  component: () => <Outlet />,
});
