import { createRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';

import { Route as orgSlugRoute } from './$orgSlug.js';
import { OnboardingPage } from '../../pages/OnboardingPage.js';
import { getUsage } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-client.js';

/**
 * First-run setup, inside the app shell rather than as a gate: the organization
 * exists by now (and has had a slug since it was created, well before it was
 * named) and the caller is in the product, so the sidebar orients them and the
 * page stays reachable afterwards instead of being a one-time detour.
 *
 * Org-scoped like every other real page — unlike `/welcome`, which runs before
 * the caller has confirmed a name but not before the org has a slug.
 *
 * Usage is polled while the page is open, so a bucket or key created from a
 * terminal ticks the matching task without anybody touching the page.
 */
export const Route = createRoute({
  getParentRoute: () => orgSlugRoute,
  path: 'new',
  component: OnboardingRoute,
});

function OnboardingRoute() {
  const { data: usage } = useQuery({
    queryKey: queryKeys.usage,
    queryFn: () => getUsage(),
    refetchInterval: 5000,
  });

  return (
    <OnboardingPage
      hasBucket={(usage?.buckets?.count ?? 0) > 0}
      hasKey={(usage?.accessKeys?.count ?? 0) > 0}
    />
  );
}
