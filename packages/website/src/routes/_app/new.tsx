import { createRoute } from '@tanstack/react-router';
import { Route as appRoute } from '../_app';
import { redirectToActiveOrgPath } from '../../lib/legacy-route-redirect.js';

/**
 * The pre-org-scoping URL for first-run setup. Kept as a redirect rather than
 * deleted: `/welcome`'s naming step used to send callers here directly, and
 * whatever anybody bookmarked or was sent still should land somewhere.
 */
export const Route = createRoute({
  path: '/new',
  getParentRoute: () => appRoute,
  beforeLoad: ({ location }) => redirectToActiveOrgPath(location.href),
});
