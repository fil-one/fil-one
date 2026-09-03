import z from 'zod';
import { createRoute, redirect } from '@tanstack/react-router';

import { Route as orgSlugRoute } from './$orgSlug';

/**
 * `tab` is what the old unified Organization page used to open on, and
 * `portal_return` rides along from Stripe's billing return. Both are still
 * accepted so the redirect below can route on them.
 */
const organizationSearchSchema = z.object({
  tab: z.enum(['members', 'invitations', 'audit', 'billing']).optional(),
  portal_return: z.string().optional(),
});

/**
 * `/organization` is gone as a page: it split into `/members` and `/billing`,
 * reached from the org switcher, with the org's own identity and rename living
 * in the switcher itself (was FIL-1094's unified page).
 *
 * Kept as a redirect rather than deleted, because the old path and its `tab` are
 * in bookmarks, in Stripe's billing return URL, and behind the shell's Upgrade
 * and Manage account banners:
 *   - `tab=billing`      → `/billing` (carrying `portal_return` for the return trip)
 *   - `tab=invitations`  → `/members?tab=invitations`
 *   - `tab=audit`        → `/audit`
 *   - anything else      → `/members`
 */
export const Route = createRoute({
  path: '/organization',
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
    throw redirect({
      to: '/$orgSlug/members',
      params,
      search: search.tab === 'invitations' ? { tab: 'invitations' } : {},
      replace: true,
    });
  },
});
