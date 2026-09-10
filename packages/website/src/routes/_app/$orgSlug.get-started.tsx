import { useEffect } from 'react';
import { createRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';

import { Route as orgSlugRoute } from './$orgSlug.js';
import { OnboardingPage } from '../../pages/OnboardingPage.js';
import { AddPaymentDialog } from '../../components/billing/AddPaymentDialog.js';
import { ChoosePlanDialog } from '../../components/billing/ChoosePlanDialog.js';
import { ContactSalesDialog } from '../../components/billing/ContactSalesDialog.js';
import { getMe, getUsage } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-client.js';
import { useBillingData, useBillingFlows } from '../../lib/use-billing.js';
import { useHasPermission } from '../../lib/use-permissions.js';
import { consumePendingOrgPaymentPrompt } from '../../lib/pending-org-payment-prompt.js';

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
 *
 * Also where a just-created additional org's payment prompt opens, when
 * `CreateOrganizationDialog` stashed one — see `pending-org-payment-prompt.ts`.
 */
export const Route = createRoute({
  getParentRoute: () => orgSlugRoute,
  path: 'get-started',
  component: OnboardingRoute,
});

function OnboardingRoute() {
  const { data: usage } = useQuery({
    queryKey: queryKeys.usage,
    queryFn: () => getUsage(),
    refetchInterval: 5000,
  });
  const { data: me } = useQuery({ queryKey: queryKeys.me, queryFn: () => getMe() });
  const mayManage = useHasPermission('billing.manage');
  const { billing } = useBillingData();
  const flows = useBillingFlows(billing, mayManage);

  // An org this dialog created (see `CreateOrganizationDialog`) has no free
  // trial — only an account's first-ever org gets one — so its first visit
  // here opens the payment prompt itself rather than leave the caller to
  // notice "No active plan" on their own. `consumePendingOrgPaymentPrompt`
  // clears the stash on the first read, so a re-render (or a reload of this
  // same page) cannot reopen it a second time.
  useEffect(() => {
    if (!me?.orgId || !mayManage) return;
    if (consumePendingOrgPaymentPrompt(me.orgId)) flows.openPlan();
    // `flows` is a fresh object every render; only the org and the permission
    // that gates opening it are what this effect keys on.
  }, [me?.orgId, mayManage]);

  return (
    <>
      <OnboardingPage
        hasBucket={(usage?.buckets?.count ?? 0) > 0}
        hasKey={(usage?.accessKeys?.count ?? 0) > 0}
      />
      <ChoosePlanDialog
        open={flows.planOpen}
        onClose={flows.closePlan}
        onSelectPayAsYouGo={flows.selectPayAsYouGo}
        onContactSales={flows.contactSalesFromPlan}
        savedCardLast4={
          flows.canReactivateWithSavedCard ? billing?.paymentMethod?.last4 : undefined
        }
        onUseDifferentCard={flows.canReactivateWithSavedCard ? flows.useDifferentCard : undefined}
      />
      <AddPaymentDialog
        open={flows.paymentOpen}
        clientSecret={flows.clientSecret}
        stripePublishableKey={flows.stripePublishableKey}
        onClose={flows.closePayment}
        onBack={flows.backToPlan}
        onSuccess={flows.paymentSucceeded}
        onRefreshSetupIntent={flows.refreshSetupIntent}
      />
      <ContactSalesDialog open={flows.contactSalesOpen} onClose={flows.closeContactSales} />
    </>
  );
}
