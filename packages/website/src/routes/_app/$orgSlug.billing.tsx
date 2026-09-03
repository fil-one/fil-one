import z from 'zod';
import { Navigate, createRoute } from '@tanstack/react-router';

import { Route as orgSlugRoute } from './$orgSlug';
import { BillingPage } from '../../pages/BillingPage';
import { PageLayout } from '../../components/PageLayout';
import { useMembersSurface } from '../../lib/use-members-surface';

/**
 * `portal_return` is Stripe's, on the return URL the portal session is opened
 * with. `use-billing` reads it off `window.location` to know the plan or the
 * card may have changed; it is declared here so the redirect below can carry it
 * to wherever billing actually renders, and so the router does not drop a
 * search param it was not told about.
 */
const billingSearchSchema = z.object({
  portal_return: z.string().optional(),
});

/**
 * `/billing`, which is a page for some orgs and a tab for others.
 *
 * Billing moved into `/organization` as a tab (FIL-1094), but an org with no
 * members surface — a solo organization outside the organizations beta — has no
 * Organization page to hold it: that route answers "inviting teammates is not
 * enabled" and nothing else. Billing is exactly the surface such an org still
 * needs, so it keeps `/billing` as a page of its own.
 *
 * The path stays the single destination either way, rather than each caller
 * choosing. It is in bookmarks, in Stripe's return URL, and behind the shell's
 * Upgrade and Manage account banners, and none of those can know which shape
 * this org's console takes.
 *
 * Split from the route's own component for the reason `OrganizationGate` is:
 * the decision is `/me` and a search param, and standing a router up to supply
 * the param would test the router.
 */
export function BillingGate({ portalReturn, orgSlug }: { portalReturn?: string; orgSlug: string }) {
  const { visible, isPending, isError } = useMembersSurface();

  // The heading is true in every state, so it goes up while `/me` is in flight,
  // the same way `/organization` does it.
  if (isPending) return <PageLayout title="Billing">{null}</PageLayout>;

  // A failed `/me` says nothing about this org's shape, and it is the wrong
  // moment to move somebody: `/organization` would fail the same read and show
  // them nothing, at a URL they did not ask for. The page stays put and fails
  // quiet inside its own permission gate.
  if (isError) return <BillingPage />;

  if (visible) {
    // Spread rather than a `portal_return: portalReturn` that is usually
    // undefined: most arrivals here are not from Stripe, and they should land on
    // a clean URL rather than one carrying an empty parameter.
    return (
      <Navigate
        to="/$orgSlug/organization"
        params={{ orgSlug }}
        search={{ tab: 'billing', ...(portalReturn ? { portal_return: portalReturn } : {}) }}
        replace
      />
    );
  }

  return <BillingPage />;
}

function BillingRoute() {
  const { portal_return } = Route.useSearch();
  const { orgSlug } = Route.useParams();
  return <BillingGate portalReturn={portal_return} orgSlug={orgSlug} />;
}

export const Route = createRoute({
  path: '/billing',
  getParentRoute: () => orgSlugRoute,
  component: BillingRoute,
  validateSearch: billingSearchSchema,
});
