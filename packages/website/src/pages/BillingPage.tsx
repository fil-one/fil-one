import { ArrowSquareOutIcon } from '@phosphor-icons/react/dist/ssr';

import { SubscriptionStatus } from '@filone/shared';

import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { Heading } from '../components/Heading/Heading.js';
import { PageLayout } from '../components/PageLayout.js';
import { RequirePermission } from '../components/RequirePermission';
import { AddPaymentDialog } from '../components/billing/AddPaymentDialog.js';
import { ChoosePlanDialog } from '../components/billing/ChoosePlanDialog.js';
import { ContactSalesDialog } from '../components/billing/ContactSalesDialog.js';
import { InvoicesCard } from '../components/billing/InvoicesCard.js';
import { PaymentMethodCard } from '../components/billing/PaymentMethodCard.js';
import { BillingHelpRail } from '../components/billing/BillingHelpRail.js';
import { PlanCard } from '../components/billing/PlanCard.js';
import { UsageCard } from '../components/billing/UsageCard.js';
import { hasInvoiceHistory, useBillingData, useBillingFlows } from '../lib/use-billing.js';
import { useHasPermission } from '../lib/use-permissions.js';

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * Where the billing surface is rendering, which is the only thing that differs
 * between the two: a page owns the `h1` and the shell's gutters, and a tab panel
 * sits inside both already, so it labels itself with the `h2` its neighbours use
 * and adds no padding of its own.
 *
 * Only the `page` chrome has a caller today: billing is its own `/billing` page
 * for every org, reached from the org switcher. The `tab` variant is what the
 * unified Organization page used before it split into `/members` and `/billing`;
 * it is kept here so the tab-vs-page seam is a single prop away if billing is
 * ever nested again.
 */
export type BillingChrome = 'page' | 'tab';

/** Said under the heading in both chromes, so it is written once. */
const BILLING_DESCRIPTION = 'Manage your plan, usage, and payment methods';

/**
 * Money is Owner-and-Admin territory: `billing.view` reads usage and invoices,
 * `billing.manage` changes the plan or the card. A Member or ReadOnly holds
 * neither, and every query on this page would 403, so the page says so instead
 * of rendering an error for each one.
 */
export function BillingPage() {
  return (
    <RequirePermission
      permission="billing.view"
      pending={
        <PageLayout title="Billing" description={BILLING_DESCRIPTION}>
          <BillingSkeleton />
        </PageLayout>
      }
      fallback={
        <PageLayout title="Billing" description={BILLING_DESCRIPTION}>
          <div className="rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-600">
            Billing is managed by your organization&rsquo;s owners and admins. Ask one of them for
            plan or invoice details.
          </div>
        </PageLayout>
      }
    >
      <BillingDetails chrome="page" />
    </RequirePermission>
  );
}

/**
 * The chrome around the cards, in whichever of the two the caller reached.
 *
 * Both put the same row of cards under the same sentence; only the heading and
 * the gutters differ. As a tab, `PageLayout` used to sit here, which put an
 * `h1` and a second set of page gutters inside a tab panel — a page title under
 * a page title.
 */
function BillingSection({
  chrome,
  children,
  rail,
}: {
  chrome: BillingChrome;
  children: React.ReactNode;
  rail?: React.ReactNode;
}) {
  const cards = (
    <div className="flex flex-col gap-8 lg:flex-row lg:gap-10">
      {/* Capped, unlike the table tabs beside it. Every row here is a label on
          the left and a figure on the right, and on a wide screen an uncapped
          card put 1700px between the two: the eye loses the pair. Tables earn
          the full width because their columns fill it; a settings surface does
          not. */}
      <div className="flex max-w-4xl min-w-0 flex-1 flex-col gap-4">{children}</div>

      {/* After the figures in the source, so the cards come first on a phone
          where the rail stacks under them. */}
      {rail}
    </div>
  );

  if (chrome === 'page') {
    return (
      <PageLayout title="Billing" headingId="billing-heading" description={BILLING_DESCRIPTION}>
        {cards}
      </PageLayout>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      {/* Above the row rather than inside its left column: as a sibling of the
          rail it set the row's top edge, so the rail started level with this
          heading instead of with the cards it sits beside. */}
      <Heading
        id="billing-heading"
        tag="h2"
        size="md"
        className="gap-0.5"
        description={BILLING_DESCRIPTION}
      >
        Billing
      </Heading>

      {cards}
    </section>
  );
}

/** One pulse per card, in the order the real ones arrive. */
function BillingSkeleton() {
  return (
    <div className="flex flex-col gap-4" data-testid="billing-skeleton">
      {['h-28', 'h-44', 'h-32'].map((height) => (
        <div
          key={height}
          className={`animate-pulse rounded-xl border border-zinc-200 bg-white p-5 shadow-xs ${height}`}
        >
          <div className="mb-4 h-4 w-32 rounded-md bg-zinc-200" />
          <div className="mb-2 h-3 w-56 rounded-md bg-zinc-200" />
          <div className="h-3 w-40 rounded-md bg-zinc-200" />
        </div>
      ))}
    </div>
  );
}

/**
 * Everything billing, in either chrome.
 *
 * Exported for the Organization page's Billing tab, which is where an org with
 * a members surface reads it. `BillingPage` renders the same cards as a page of
 * their own, for an org that has no Organization page to put them in.
 *
 * One column of cards, each answering one question: what plan is this, what has
 * it used, how does it pay, what has it been billed. Every number comes from
 * `billing-view`, which states a rate only where Stripe reported one — this tab
 * used to work the bill out from a hardcoded $4.99 per TB, which is right for
 * the self-serve price and wrong for every customer whose price came from a
 * quote.
 */
export function BillingDetails({ chrome = 'tab' }: { chrome?: BillingChrome } = {}) {
  const mayManage = useHasPermission('billing.manage');
  const { billing, usage, invoices, loading, error, invoicesPending, invoicesFailed } =
    useBillingData();
  const flows = useBillingFlows(billing, mayManage);

  if (loading && !billing) {
    return (
      <BillingSection chrome={chrome}>
        <BillingSkeleton />
      </BillingSection>
    );
  }

  if (error && !billing) {
    return (
      <BillingSection chrome={chrome}>
        <Alert variant="red" title="Unable to load billing" description={error} />
      </BillingSection>
    );
  }

  if (!billing) return null;

  const { status } = billing.subscription;

  return (
    <BillingSection
      chrome={chrome}
      rail={<BillingHelpRail status={status} onContactSales={flows.openContactSales} />}
    >
      <StatusBanner
        status={status}
        mayManage={mayManage}
        onManage={flows.openStripePortal}
        onChoosePlan={flows.openPlan}
      />

      {/* Paired because they hold the same amount: a title, one line of fact,
          and one action each. Usage carries three rows and a total, so pairing
          it with the payment card left the shorter one stretched to match, with
          a card's worth of empty space under a single line of text. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <PlanCard
          subscription={billing.subscription}
          mayManage={mayManage}
          onManage={flows.openStripePortal}
          onChoosePlan={flows.openPlan}
        />

        <PaymentMethodCard
          billing={billing}
          mayManage={mayManage}
          onManage={flows.openStripePortal}
          onAddCard={flows.openPlan}
        />
      </div>

      {/* Full width: the figures align to the right edge across the card, which
          is how a statement reads. */}
      <UsageCard
        subscription={billing.subscription}
        storageBytesUsed={usage?.storage.usedBytes ?? 0}
        egressBytesUsed={usage?.egress.usedBytes ?? 0}
      />

      {hasInvoiceHistory(status) && (
        <InvoicesCard
          invoices={invoices?.invoices}
          loading={invoicesPending}
          errorMessage={invoicesFailed ? 'Unable to load invoices. Please try again later.' : ''}
          onViewAll={mayManage ? flows.openStripePortal : undefined}
        />
      )}

      <ChoosePlanDialog
        open={flows.planOpen}
        onClose={flows.closePlan}
        onSelectPayAsYouGo={flows.selectPayAsYouGo}
        onContactSales={flows.contactSalesFromPlan}
        savedCardLast4={flows.canReactivateWithSavedCard ? billing.paymentMethod?.last4 : undefined}
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
    </BillingSection>
  );
}

/**
 * The one thing wrong with this account, when something is.
 *
 * Above the cards, because it is about the whole account rather than any one of
 * them, and it carries its own action so the remedy sits with the problem. An
 * Admin without `billing.manage` still sees the state and who to ask: the
 * banner is information, and only the button is a permission.
 */
function StatusBanner({
  status,
  mayManage,
  onManage,
  onChoosePlan,
}: {
  status: SubscriptionStatus;
  mayManage: boolean;
  onManage: () => void;
  onChoosePlan: () => void;
}) {
  if (status === SubscriptionStatus.PastDue) {
    return (
      <Alert
        variant="amber"
        title="Your last payment failed"
        description={
          mayManage
            ? 'Update your payment method in Stripe to keep access to your data.'
            : 'An organization owner needs to update the payment method to keep access to your data.'
        }
        action={
          mayManage ? (
            <Button
              variant="ghost"
              size="sm"
              icon={ArrowSquareOutIcon}
              iconPosition="right"
              onClick={onManage}
            >
              Update payment
            </Button>
          ) : undefined
        }
      />
    );
  }

  if (status === SubscriptionStatus.GracePeriod) {
    return (
      <Alert
        variant="amber"
        title="This organization is read-only"
        description={
          mayManage
            ? 'Choose a plan to restore writes. Your data is still here.'
            : 'An organization owner can choose a plan to restore writes. Your data is still here.'
        }
        action={
          mayManage ? (
            <Button variant="warning" size="sm" onClick={onChoosePlan}>
              Choose a plan
            </Button>
          ) : undefined
        }
      />
    );
  }

  if (status === SubscriptionStatus.Canceled) {
    return (
      <Alert
        variant="red"
        title="This subscription is canceled"
        description={
          mayManage
            ? 'Reactivate to regain access. Your data is still here.'
            : 'An organization owner can reactivate it. Your data is still here.'
        }
        action={
          mayManage ? (
            <Button variant="destructive" size="sm" onClick={onChoosePlan}>
              Reactivate
            </Button>
          ) : undefined
        }
      />
    );
  }

  return null;
}
