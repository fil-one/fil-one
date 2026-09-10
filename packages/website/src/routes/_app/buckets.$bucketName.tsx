import { Route as appRoute } from '../_app';
import { legacyRedirectRoute } from '../../lib/legacy-route-redirect.js';

/** The pre-org-scoping URL. See `dashboard.tsx` for why this stays. */
export const Route = legacyRedirectRoute({
  path: '/buckets/$bucketName',
  getParentRoute: () => appRoute,
});
