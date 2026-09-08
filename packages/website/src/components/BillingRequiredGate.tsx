import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CreditCardIcon } from '@phosphor-icons/react/dist/ssr';

import { AddPaymentDialog } from './billing/AddPaymentDialog.js';
import { ChoosePlanDialog } from './billing/ChoosePlanDialog.js';
import { ContactSalesDialog } from './billing/ContactSalesDialog.js';
import { Button } from './Button.js';
import { EmptyStateCard } from './EmptyStateCard.js';
import { useBillingData, useBillingFlows } from '../lib/use-billing.js';
import { useHasPermission } from '../lib/use-permissions.js';
import { queryKeys } from '../lib/query-client.js';

/**
 * What every page in an org becomes once `/me` reports `billingActive: false`
 * — no plan has ever been chosen, so there is nothing here to read, write, or
 * store objects in yet. Swapped in for `<Outlet/>` inside `AppShell`, not a
 * route of its own: the sidebar (org switcher, log out) stays reachable,
 * because leaving for another org or ending the session are the two things a
 * blocked account can still do.
 *
 * Two readings, same as every other org-wide state this console gates on
 * (compare the disabled-account banner): `billing.manage` (Owner only — Admin
 * holds `billing.view` but not this) gets the fix in front of them, the same
 * Choose a plan / add a card flow `BillingPage` itself uses, and everyone
 * else gets told who to ask, not a button that would 403.
 */
export function BillingRequiredGate() {
  const mayManage = useHasPermission('billing.manage');
  const { billing } = useBillingData();
  const flows = useBillingFlows(billing, mayManage);
  const queryClient = useQueryClient();

  // `billingActive` lives on `/me`, not on `billing` — a query the flows above
  // already invalidate on activation, but never this one, since nothing else
  // in the console has needed `/me` to notice a subscription change before
  // this gate existed. Without this, the gate would keep blocking for up to
  // `ME_STALE_TIME` after a successful activation.
  useEffect(() => {
    const onBillingUpdated = () => void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    window.addEventListener('billing:updated', onBillingUpdated);
    return () => window.removeEventListener('billing:updated', onBillingUpdated);
  }, [queryClient]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6">
      <EmptyStateCard
        icon={CreditCardIcon}
        iconColor="blue"
        title="Add a payment method to continue"
        description={
          mayManage
            ? 'This organization has no active plan. Choose one to start storing data.'
            : 'This organization has no active plan. Ask an Owner to add a payment method.'
        }
      >
        {mayManage && (
          <>
            <Button variant="primary" size="md" onClick={flows.openPlan}>
              Choose a plan
            </Button>
            <ChoosePlanDialog
              open={flows.planOpen}
              onClose={flows.closePlan}
              onSelectPayAsYouGo={flows.selectPayAsYouGo}
              onContactSales={flows.contactSalesFromPlan}
              savedCardLast4={
                flows.canReactivateWithSavedCard ? billing?.paymentMethod?.last4 : undefined
              }
              onUseDifferentCard={
                flows.canReactivateWithSavedCard ? flows.useDifferentCard : undefined
              }
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
        )}
      </EmptyStateCard>
    </div>
  );
}
