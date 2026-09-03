import { createRoute } from '@tanstack/react-router';
import { Route as appRoute } from '../_app';
import { redirectToActiveOrgPath } from '../../lib/legacy-route-redirect.js';

/** The pre-org-scoping URL. See `dashboard.tsx` for why this stays. */
export const Route = createRoute({
  path: '/support',
  getParentRoute: () => appRoute,
  beforeLoad: ({ location }) => redirectToActiveOrgPath(location.href),
});
