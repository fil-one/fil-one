import { createRoute } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';
import { AuditPage } from '../../pages/AuditPage';
import { RequireOrgsBeta } from '../../components/RequireOrgsBeta';

/**
 * `/audit`, a page of the organizations beta.
 *
 * `AuditPage` owns its heading and its `audit.view` gate, so the route only
 * adds the beta's, matching `/members`.
 */
function AuditRoute() {
  return (
    <RequireOrgsBeta>
      <AuditPage />
    </RequireOrgsBeta>
  );
}

export const Route = createRoute({
  path: '/audit',
  getParentRoute: () => appRoute,
  component: AuditRoute,
});
