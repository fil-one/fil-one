import z from 'zod';
import { createRoute, redirect } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';

/**
 * `tab` is what the old unified Organization page opened on, and
 * `portal_return` rides along from Stripe's billing return. Both are still
 * accepted so the redirect below can route on them.
 */
const organizationSearchSchema = z.object({
  tab: z.enum(['members', 'invitations', 'audit', 'billing']).optional(),
  portal_return: z.string().optional(),
});

/**
 * `/organization` was the unified Organization page, opening on Members, until
 * it split into `/members`, `/billing`, and `/audit`. Kept as a redirect to
 * the page each old link meant, because the path and its `tab` are in
 * bookmarks, in emailed links, and in Stripe's billing return URL:
 *   - `tab=billing`      → `/billing` (carrying `portal_return` for the return trip)
 *   - `tab=audit`        → `/audit`
 *   - `tab=invitations`  → `/members?tab=invitations`
 *   - anything else      → `/members`, what the old page opened on
 *
 * Not to `/edit-organization`: nothing linked there before it existed, and a
 * Member following an old link would land on a page they cannot use. The
 * console's own links go to `/edit-organization` directly. `replace` so the
 * back button returns where the caller came from rather than bouncing through
 * here again.
 */
export const Route = createRoute({
  path: '/organization',
  getParentRoute: () => appRoute,
  validateSearch: organizationSearchSchema,
  beforeLoad: ({ search }) => {
    if (search.tab === 'billing') {
      throw redirect({
        to: '/billing',
        search: search.portal_return ? { portal_return: search.portal_return } : {},
        replace: true,
      });
    }
    if (search.tab === 'audit') {
      throw redirect({ to: '/audit', replace: true });
    }
    throw redirect({
      to: '/members',
      search: search.tab === 'invitations' ? { tab: 'invitations' } : {},
      replace: true,
    });
  },
});
