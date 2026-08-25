import { createRoute, redirect } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';

/**
 * Billing is a tab of `/organization` now (FIL-1094).
 *
 * Kept as a redirect rather than deleted: the path is in bookmarks, in Stripe's
 * return URLs, and in whatever anybody has linked to it.
 */
export const Route = createRoute({
  path: '/billing',
  getParentRoute: () => appRoute,
  beforeLoad: () => {
    throw redirect({ to: '/organization', replace: true });
  },
});
