import { createRoute, redirect } from '@tanstack/react-router';
import { Route as orgSlugRoute } from './$orgSlug.js';

/**
 * `/{orgSlug}` alone has no page of its own — the same reasoning `/` redirecting
 * to `/dashboard` follows, so a bare org URL lands on the dashboard rather than
 * rendering an empty `AppShell` around nothing.
 */
export const Route = createRoute({
  getParentRoute: () => orgSlugRoute,
  path: '/',
  beforeLoad: ({ params }) => {
    throw redirect({ href: `/${params.orgSlug}/dashboard`, replace: true });
  },
});
