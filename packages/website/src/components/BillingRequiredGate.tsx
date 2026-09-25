import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { SubscriptionStatus } from '@filone/shared';
import { CreditCardIcon } from '@phosphor-icons/react/dist/ssr';

import { AddPaymentDialog } from './billing/AddPaymentDialog.js';
import { ContactSalesDialog } from './billing/ContactSalesDialog.js';
import { Button } from './Button.js';
import { EmptyStateCard } from './EmptyStateCard.js';
import { Spinner } from './Spinner.js';
import { textButtonClassName } from './text-button.js';
import { useBillingData, useBillingFlows } from '../lib/use-billing.js';
import { useHasPermission } from '../lib/use-permissions.js';
import { queryKeys } from '../lib/query-client.js';

/**
 * What every page in an org becomes once `/me` reports `billingActive: false`
 * — no plan has ever been chosen, so there is nothing here to read, write, or
 * store objects in yet. Swapped in for `<Outlet/>` inside `AppShell`, not a
 * route of its own: the sidebar's org switcher and log out stay reachable
 * (the page-nav links are hidden), and so do Settings, Edit organization and Support (see
 * `_app.tsx`), where a blocked org can still be left or deleted.
 *
 * The primary action goes straight to the card form, skipping the plan
 * choice `BillingPage` itself offers: `get-me.ts`'s `resolveBillingActive`
 * only ever reports false for "no subscription record" or
 * `SubscriptionStatus.Inactive`, never GracePeriod/Canceled/PastDue, so the
 * one thing `selectPayAsYouGo` could otherwise branch on — reactivating a
 * saved card — never applies here. There is exactly one plan (pay as you
 * go), so the choice in front of it would have been asking a question with
 * one answer.
 *
 * Two readings, same as every other org-wide state this console gates on
 * (compare the disabled-account banner): `billing.manage` (Owner only — Admin
 * holds `billing.view` but not this) gets the fix in front of them, and
 * everyone else gets told who to ask, not a button that would 403.
 */
export function BillingRequiredGate() {
  const mayManage = useHasPermission('billing.manage');
  // A Member or ReadOnly caller may not read billing, and the 403 they would
  // get is not an outage: the gate only has to tell them to ask an Owner.
  const mayView = useHasPermission('billing.view');
  const { billing, error } = useBillingData({ enabled: mayView });
  const flows = useBillingFlows(billing, mayManage);
  const queryClient = useQueryClient();
  // `selectPayAsYouGo` presigns a SetupIntent before the dialog can open —
  // real latency with nothing else on the page to show for it, so the button
  // says so itself rather than leaving a click looking like it did nothing.
  const [startingPayment, setStartingPayment] = useState(false);

  async function handleAddPaymentMethod(): Promise<void> {
    setStartingPayment(true);
    try {
      await flows.selectPayAsYouGo();
    } finally {
      setStartingPayment(false);
    }
  }

  // `billingActive` lives on `/me`, not on `billing`. Once `billing` reports
  // any active status (a payment the flows above just made, or a trial this
  // very `GET /api/billing` claimed, see `get-billing.ts`), `/me` is stale and
  // would keep the gate up for `ME_STALE_TIME`. The gate never stands in front
  // of Grace/Canceled/PastDue (`resolveBillingActive` reports those as
  // active), so any status but Inactive means `/me` is wrong.
  useEffect(() => {
    if (billing && billing.subscription.status !== SubscriptionStatus.Inactive) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    }
  }, [billing, queryClient]);

  // Billing that could not be read at all is not "no plan": `GET /api/billing`
  // answers 503 for an account whose billing stands where this org cannot see
  // it (a pre-re-key row), and the card form refuses it too. Offering a card
  // there is a button that can only fail, so the gate says what is wrong and
  // where to get it fixed.
  if (error && !billing) return <BillingUnavailable message={error} />;

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 px-6">
      <EmptyStateCard
        icon={CreditCardIcon}
        iconColor="blue"
        title="Add a payment method to continue"
        description={
          mayManage
            ? 'This organization has no active plan. Add a card to start storing data.'
            : 'This organization has no active plan. Ask an Owner to add a payment method.'
        }
      >
        {mayManage && (
          <Button
            variant="primary"
            size="md"
            disabled={startingPayment}
            onClick={() => void handleAddPaymentMethod()}
          >
            {/* Button's own inner wraps `children` in a single `<span>`, so
                without a flex container of our own the Spinner (a `<div>`,
                block by default) breaks onto its own line above the label
                instead of sitting beside it. */}
            <span className="inline-flex items-center gap-2">
              {startingPayment && (
                <Spinner ariaLabel="Starting checkout" size={14} colorClassName="text-current" />
              )}
              Add payment method
            </span>
          </Button>
        )}
      </EmptyStateCard>
      {mayManage && (
        <>
          {/* zinc-500, not zinc-400: this text is 12px, and zinc-400 on white
              falls short of the 4.5:1 contrast ratio small text needs under
              WCAG AA. */}
          <p className="max-w-48 text-center text-xs text-zinc-500">
            Have compliance or predictable volume needs?{' '}
            <button type="button" onClick={flows.openContactSales} className={textButtonClassName}>
              Talk to sales
            </button>
          </p>
          <AddPaymentDialog
            open={flows.paymentOpen}
            clientSecret={flows.clientSecret}
            stripePublishableKey={flows.stripePublishableKey}
            onClose={flows.closePayment}
            // No plan step behind this one to return to here (there is
            // exactly one plan), so "Back" and the close button do the same
            // thing: close the dialog and leave the caller on the gate.
            onBack={flows.closePayment}
            onSuccess={flows.paymentSucceeded}
            onRefreshSetupIntent={flows.refreshSetupIntent}
          />
          <ContactSalesDialog open={flows.contactSalesOpen} onClose={flows.closeContactSales} />
        </>
      )}
    </div>
  );
}

/** The gate when billing itself could not be read. Support is past the gate. */
function BillingUnavailable({ message }: { message: string }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 px-6">
      <EmptyStateCard
        icon={CreditCardIcon}
        iconColor="grey"
        title="Billing details are unavailable"
        description={message}
      >
        <Button variant="primary" size="md" href="/support">
          Contact support
        </Button>
      </EmptyStateCard>
    </div>
  );
}
