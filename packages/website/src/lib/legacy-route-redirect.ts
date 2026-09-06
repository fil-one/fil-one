import { createRoute, notFound, redirect } from '@tanstack/react-router';
import type { AnyRoute } from '@tanstack/react-router';

import { getMe } from './api.js';

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** Set by {@link legacyRedirectRoute} — lets a route-tree check tell a
     * deliberate legacy-redirect stub apart from a genuinely new page that
     * happens to live outside `$orgSlug`. */
    legacyRedirect?: boolean;
  }
}
import { queryClient, queryKeys, ME_STALE_TIME } from './query-client.js';
import { findActiveMembership } from './org-membership-slug.js';

/**
 * Where a pre-org-scoping bookmark or emailed link for `path` (e.g.
 * `/dashboard`, `/buckets/my-bucket?region=us-east`, or `/organization` for
 * the old `/members`) sends the caller now: their active org's version of it.
 *
 * `path` is expected to already carry whatever the old flat route needs to
 * preserve — a bucket name in the path, a search string, and so on — this
 * only ever prepends the slug. Most callers pass `location.href` straight
 * through; `/members` is the one exception, since it already redirected to a
 * different path (`/organization`) before the console had org-scoped URLs at
 * all.
 *
 * Kept as a redirect rather than deleted so those links keep working.
 *
 * `/me` is refetched (or served from cache, if `_app`'s own `beforeLoad` ran
 * first on this navigation) rather than threaded through, so every stub route
 * can call this the same way without a router context to carry it.
 */
export async function redirectToActiveOrgPath(path: string): Promise<never> {
  const me = await queryClient.fetchQuery({
    queryKey: queryKeys.me,
    queryFn: () => getMe(),
    staleTime: ME_STALE_TIME,
  });

  const active = findActiveMembership(me);

  // No org to send this caller into — no memberships at all, or (until the
  // backend backfill for this stage has run) an org with no slug yet. There is
  // no scoped URL to build, so the router's own not-found page says so instead
  // of constructing a broken redirect target.
  if (!active?.slug) throw notFound();

  throw redirect({ href: `/${active.slug}${path}`, replace: true });
}

/**
 * A whole legacy-redirect route file in one call: register `path` and send it
 * through {@link redirectToActiveOrgPath}. Every one of these stub files was
 * otherwise the same four lines with only `path` (and occasionally `target`)
 * differing — this is that shape, named once, so adding the next one is a
 * one-line call rather than a new file copied from the last.
 *
 * `target`, when given, is the fixed destination `organization.tsx` needs
 * (its own path moved, so `location.href` would build a link to the old
 * scoped path). Omitted, the default carries `location.href` through
 * unchanged — the common case, and the one that preserves a search string
 * like `billing.tsx`'s `portal_return`.
 *
 * Tagged `legacyRedirect` in `staticData` so `use-org-path.test.ts` can tell
 * these apart from a genuinely new unscoped page when it checks that every
 * route outside `$orgSlug` is accounted for.
 */
export function legacyRedirectRoute({
  path,
  getParentRoute,
  target,
}: {
  path: string;
  getParentRoute: () => AnyRoute;
  target?: string;
}): AnyRoute {
  return createRoute({
    path,
    getParentRoute,
    staticData: { legacyRedirect: true },
    beforeLoad: target
      ? () => redirectToActiveOrgPath(target)
      : ({ location }) => redirectToActiveOrgPath(location.href),
  });
}
