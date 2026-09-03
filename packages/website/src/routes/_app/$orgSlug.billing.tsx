import z from 'zod';
import { createRoute } from '@tanstack/react-router';

import { Route as orgSlugRoute } from './$orgSlug';
import { BillingPage } from '../../pages/BillingPage';

/**
 * `portal_return` is Stripe's, on the return URL the portal session is opened
 * with. `use-billing` reads it off `window.location` to know the plan or the
 * card may have changed; it is declared here so the router does not drop a
 * search param it was not told about.
 */
const billingSearchSchema = z.object({
  portal_return: z.string().optional(),
});

/**
 * `/billing`, a page of its own for every org.
 *
 * Billing was a tab of the unified Organization page for orgs with a members
 * surface and a standalone page for the rest (FIL-1094). That page is gone now,
 * so billing is simply always its own page, reached from the org switcher.
 * `BillingPage` owns its heading and its `billing.view` gate, so the route is a
 * thin wrapper.
 */
export const Route = createRoute({
  path: '/billing',
  getParentRoute: () => orgSlugRoute,
  component: BillingPage,
  validateSearch: billingSearchSchema,
});
