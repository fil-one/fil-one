import { createRoute, redirect } from '@tanstack/react-router';
import { Route as authRoute } from '../_auth';

export const Route = createRoute({
  path: '/sign-up',
  getParentRoute: () => authRoute,
  beforeLoad: () => {
    // Redirect to the server-side login endpoint with signup hint.
    throw redirect({ href: '/login?screen_hint=signup', reloadDocument: true });
  },
  component: () => null,
});
