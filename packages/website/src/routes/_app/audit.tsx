import { createRoute } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';
import { AuditPage } from '../../pages/AuditPage';

/** `/audit`. `AuditPage` owns its heading and its `audit.view` gate. */
export const Route = createRoute({
  path: '/audit',
  getParentRoute: () => appRoute,
  component: AuditPage,
});
