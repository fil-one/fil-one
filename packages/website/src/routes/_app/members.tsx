import { Route as appRoute } from '../_app';
import { legacyRedirectRoute } from '../../lib/legacy-route-redirect.js';

/**
 * The members roster is its own org-scoped page again (`/$orgSlug/members`),
 * reached from the org switcher, since the console's whole URL space became
 * org-scoped.
 *
 * Kept as a redirect rather than deleted: the flat path is in the sidebar's
 * history, in bookmarks, and in whatever anybody has linked to it. `replace` so
 * the back button returns where the caller came from rather than bouncing
 * through here again.
 */
export const Route = legacyRedirectRoute({
  path: '/members',
  getParentRoute: () => appRoute,
  target: '/members',
});
