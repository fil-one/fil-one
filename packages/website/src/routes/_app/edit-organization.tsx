import { createRoute } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';
import { EditOrganizationPage } from '../../pages/EditOrganizationPage.js';

/**
 * `/organization` split into `/members`, `/billing`, and `/audit` under
 * FIL-1094, with the org's own identity and rename folded into a quick dialog
 * on the org switcher. That dialog has since grown into its own page — a
 * permanent home for Delete organization rather than a spot inside a rename
 * dialog — a real page again: `EditOrganizationPage`, at `/edit-organization`.
 *
 * Old `/organization` links, and their `tab` values, are routed by
 * `organization.tsx`, not here: nothing linked to this path before it
 * existed.
 */
export const Route = createRoute({
  path: '/edit-organization',
  getParentRoute: () => appRoute,
  component: EditOrganizationPage,
});
