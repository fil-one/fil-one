import { createRoute } from '@tanstack/react-router';
import { Route as appRoute } from '../_app';
import { redirectToActiveOrgPath } from '../../lib/legacy-route-redirect.js';

/**
 * The pre-org-scoping URL. See `dashboard.tsx` for why this stays.
 *
 * Destination hardcoded rather than passed through, the way `members.tsx`
 * does: the org-scoped page itself moved from `/organization` to
 * `/edit-organization`, so `location.href` would build a link to the old
 * scoped path (which redirects again, but there is no reason to make it).
 */
export const Route = createRoute({
  path: '/organization',
  getParentRoute: () => appRoute,
  beforeLoad: () => redirectToActiveOrgPath('/edit-organization'),
});
