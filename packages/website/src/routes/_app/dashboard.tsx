import { Route as appRoute } from '../_app';
import { legacyRedirectRoute } from '../../lib/legacy-route-redirect.js';

/**
 * The pre-org-scoping URL. Kept as a redirect rather than deleted: it is in
 * bookmarks, in the Auth0 login callback, and in whatever anybody has linked
 * to it. `replace` so the back button returns where the caller came from
 * rather than bouncing through here again.
 */
export const Route = legacyRedirectRoute({ path: '/dashboard', getParentRoute: () => appRoute });
