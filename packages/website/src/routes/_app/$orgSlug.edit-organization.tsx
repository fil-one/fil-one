import z from 'zod';
import { createRoute, redirect } from '@tanstack/react-router';

import { Route as orgSlugRoute } from './$orgSlug';
import { OrganizationPage } from '../../pages/OrganizationPage.js';

/**
 * `tab` is what the old unified Organization page used to open on, and
 * `portal_return` rides along from Stripe's billing return. Both are still
 * accepted so the redirects below can route on them.
 */
const organizationSearchSchema = z.object({
  tab: z.enum(['members', 'invitations', 'audit', 'billing']).optional(),
  portal_return: z.string().optional(),
});

/**
 * `/organization` split into `/members`, `/billing`, and `/audit` under
 * FIL-1094, with the org's own identity and rename folded into a quick dialog
 * on the org switcher. That dialog has since grown into its own page — a
 * permanent home for Delete organization rather than a spot inside a rename
 * dialog — a real page again: `OrganizationPage`, at `/edit-organization`
 * (`/organization` itself now just redirects here, see
 * `$orgSlug.organization.tsx`).
 *
 * The old `tab` values that name a *different* page still redirect, because
 * they are in bookmarks, in Stripe's billing return URL, and behind the
 * shell's Upgrade and Manage account banners:
 *   - `tab=billing`      → `/billing` (carrying `portal_return` for the return trip)
 *   - `tab=invitations`  → `/members?tab=invitations`
 *   - `tab=audit`        → `/audit`
 *   - anything else (including no `tab` at all) → this page
 */
export const Route = createRoute({
  path: '/edit-organization',
  getParentRoute: () => orgSlugRoute,
  validateSearch: organizationSearchSchema,
  beforeLoad: ({ params, search }) => {
    if (search.tab === 'billing') {
      throw redirect({
        to: '/$orgSlug/billing',
        params,
        search: search.portal_return ? { portal_return: search.portal_return } : {},
        replace: true,
      });
    }
    if (search.tab === 'audit') {
      throw redirect({
        to: '/$orgSlug/audit',
        params,
        replace: true,
      });
    }
    if (search.tab === 'invitations') {
      throw redirect({
        to: '/$orgSlug/members',
        params,
        search: { tab: 'invitations' },
        replace: true,
      });
    }
  },
  component: OrganizationPage,
});
