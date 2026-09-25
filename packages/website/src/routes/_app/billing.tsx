import z from 'zod';
import { createRoute } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';
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

/** `BillingPage` owns its heading and its `billing.view` gate. */
export const Route = createRoute({
  path: '/billing',
  getParentRoute: () => appRoute,
  component: BillingPage,
  validateSearch: billingSearchSchema,
});
