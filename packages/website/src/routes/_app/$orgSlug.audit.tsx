import { createRoute } from '@tanstack/react-router';

import { Route as orgSlugRoute } from './$orgSlug';
import { AuditPage } from '../../pages/AuditPage';

/**
 * `/audit`, a page of its own for every org.
 *
 * `AuditPage` owns its heading and its `audit.view` gate, so the route is a
 * thin wrapper, matching `/billing` and `/members`.
 */
export const Route = createRoute({
  path: '/audit',
  getParentRoute: () => orgSlugRoute,
  component: AuditPage,
});
