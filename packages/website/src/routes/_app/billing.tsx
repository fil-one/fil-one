import { Route as appRoute } from '../_app';
import { legacyRedirectRoute } from '../../lib/legacy-route-redirect.js';

/**
 * The pre-org-scoping URL. See `dashboard.tsx` for why this stays.
 *
 * `location.href` carries the search string along, `portal_return` included —
 * Stripe's own configured return URL still names this flat path, and
 * `use-billing` needs that query param to survive the trip to
 * `/$orgSlug/billing`.
 */
export const Route = legacyRedirectRoute({ path: '/billing', getParentRoute: () => appRoute });
