import { createRoute } from '@tanstack/react-router';
import { Route as appRoute } from '../_app';
import { redirectToActiveOrgPath } from '../../lib/legacy-route-redirect.js';

/**
 * The pre-org-scoping URL. See `dashboard.tsx` for why this stays.
 *
 * `location.href` carries the search string along, `portal_return` included —
 * Stripe's own configured return URL still names this flat path, and
 * `use-billing` needs that query param to survive the trip to
 * `/$orgSlug/billing`.
 */
export const Route = createRoute({
  path: '/billing',
  getParentRoute: () => appRoute,
  beforeLoad: ({ location }) => redirectToActiveOrgPath(location.href),
});
