import { createRoute } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';
import { redirectToActiveOrgPath } from '../../lib/legacy-route-redirect.js';

/**
 * The roster is a tab of `/organization` now (FIL-1094), which is itself
 * org-scoped (`/$orgSlug/organization`) since the console's whole URL space
 * became org-scoped.
 *
 * Kept as a redirect rather than deleted: the path is in the sidebar's history,
 * in bookmarks, and in whatever anybody has linked to it. `replace` so the back
 * button returns where the caller came from rather than bouncing through here
 * again.
 */
export const Route = createRoute({
  path: '/members',
  getParentRoute: () => appRoute,
  beforeLoad: () => redirectToActiveOrgPath('/organization'),
});
