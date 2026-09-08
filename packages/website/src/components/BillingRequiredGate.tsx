import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CreditCardIcon } from '@phosphor-icons/react/dist/ssr';

import { AddPaymentDialog } from './billing/AddPaymentDialog.js';
import { ContactSalesDialog } from './billing/ContactSalesDialog.js';
import { Button } from './Button.js';
import { EmptyStateCard } from './EmptyStateCard.js';
import { useBillingData, useBillingFlows } from '../lib/use-billing.js';
import { useHasPermission } from '../lib/use-permissions.js';
import { queryKeys } from '../lib/query-client.js';

// Same shape as the "Not your account? Sign out" footer on WelcomePage,
// VerifyEmailPage, and LeftLastOrgPage: a secondary path stated as a plain
// question with a text link answering it, not a second button competing with
// the primary one.
const textLink =
  'rounded-xs font-medium text-brand-600 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600';

/**
 * What every page in an org becomes once `/me` reports `billingActive: false`
 * — no plan has ever been chosen, so there is nothing here to read, write, or
 * store objects in yet. Swapped in for `<Outlet/>` inside `AppShell`, not a
 * route of its own: the sidebar's org switcher and log out stay reachable
 * (the page-nav links are the ones `AppShell` hides here, via
 * `hideNavLinks`), because leaving for another org or ending the session are
 * the two things a blocked account can still do.
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
          <Button variant="primary" size="md" onClick={() => void flows.selectPayAsYouGo()}>
            Add payment method
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
            <button type="button" onClick={flows.openContactSales} className={textLink}>
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
