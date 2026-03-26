import { createRoute, redirect } from '@tanstack/react-router';
import { Route as authRoute } from '../_auth';

export const Route = createRoute({
  path: '/sign-in',
  getParentRoute: () => authRoute,
  beforeLoad: () => {
    // Redirect to the server-side login endpoint which sets the OAuth state
    // cookie and 302s to Auth0 Universal Login.
    throw redirect({ href: '/login', reloadDocument: true });
  },
  component: () => null,
});
