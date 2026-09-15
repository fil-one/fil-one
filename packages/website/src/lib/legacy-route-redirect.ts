import { notFound, redirect } from '@tanstack/react-router';

import { getMe } from './api.js';
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
