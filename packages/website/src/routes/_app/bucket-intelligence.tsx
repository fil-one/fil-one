import { createRoute, redirect } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';

/**
 * `/bucket-intelligence` was a page the console no longer offers. Kept as a redirect
 * to the dashboard because the path is in bookmarks and emailed links.
 * `replace` so the back button returns where the caller came from rather than
 * bouncing through here again.
 */
export const Route = createRoute({
  path: '/bucket-intelligence',
  getParentRoute: () => appRoute,
  beforeLoad: () => {
    throw redirect({ to: '/dashboard', replace: true });
  },
});
