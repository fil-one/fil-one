import type Stripe from 'stripe';
import { reportOrgUsage } from './org-usage-report.js';
import { syncTenantStatusInProvisionedRegions } from './region-helpers.js';
import { getStripeClient, isStripeResourceMissing } from './stripe-client.js';
import { readSubscription } from './subscription-store.js';
import type { SubscriptionRecord } from './dynamo-records.js';

const LOG = '[deletion-stripe]';

/** Statuses with nothing left to cancel or invoice. */
const SETTLED_STATUSES = new Set<Stripe.Subscription.Status>(['canceled', 'incomplete_expired']);

/** What the teardown reads off the org's row: the customer, and the period to bill. */
const TEARDOWN_PROJECTION = 'stripeCustomerId, subscriptionId, currentPeriodStart';

/**
 * Disables the tenants, bills what is owed, collects it once, then deletes the
 * customer. The delete is the whole erasure — per Stripe it "removes all credit
 * card details and prevents any further operations", taking email and metadata
 * with it — so there is no field-clearing or detach step.
 *
 * One customer per org, read off the org's subscription row. Membership means
 * riding the org's billing, so the members have no Stripe objects of their own
 * to cancel and the pass deletes one customer however many members there are.
 *
 * The disable comes first so the meter is not moving underneath the figure the
 * customer is billed for. A request already in flight when it lands can still add
 * its last writes, and that residue goes unbilled; it is bounded by a request
 * timeout measured in seconds.
 *
 * Every step treats a missing or already-deleted customer as success, because a
 * deletion triggered by the customer's deletion in Stripe finds it already gone,
 * and so does every re-drive after the first.
 */
export async function tearDownStripe(orgId: string): Promise<void> {
  await syncTenantStatusInProvisionedRegions(orgId, 'disabled');

  // Consistent: the row may have been written moments earlier, and a stale read
  // that missed the customer would leave a live subscription behind.
  const subscription = await readSubscription(orgId, {
    consistentRead: true,
    projectionExpression: TEARDOWN_PROJECTION,
  });

  const customerId = subscription?.stripeCustomerId;
  if (!customerId) {
    // Legal: an org that never onboarded has no customer, and neither has an
    // org whose row is missing entirely. Both make the pass a no-op here.
    console.log(`${LOG} no Stripe customer on the org row, nothing to tear down`, { orgId });
    return;
  }

  await tearDownCustomer(orgId, customerId, subscription);
}

async function tearDownCustomer(
  orgId: string,
  customerId: string,
  subscription: SubscriptionRecord,
): Promise<void> {
  const stripe = getStripeClient();

  const subscriptions = await cancellableSubscriptions(customerId);

  // Before the cancel: a meter event after cancellation lands on no invoice.
  await reportOutstandingUsage(orgId, customerId, subscription);

  // customers.del cancels subscriptions too, but silently and without an
  // invoice — this explicit cancel is what makes the usage billable.
  const paymentMethodIds: string[] = [];
  for (const subscription of subscriptions) {
    paymentMethodIds.push(...defaultPaymentMethodOf(subscription));
    try {
      await stripe.subscriptions.cancel(subscription.id, { invoice_now: true, prorate: false });
    } catch (err) {
      if (!isStripeResourceMissing(err)) throw err;
    }
  }

  await collectFinalInvoices(customerId, paymentMethodIds);

  try {
    await stripe.customers.del(customerId);
  } catch (err) {
    // Probed: a repeat delete 404s, so every re-drive lands here.
    if (!isStripeResourceMissing(err)) throw err;
  }
}

/**
 * The same per-org call the 12-hourly cron makes, over the period the retained
 * billing row still describes. Best-effort: an unbillable final period must not
 * wedge a teardown, and the re-drive reports the same absolute value anyway.
 */
async function reportOutstandingUsage(
  orgId: string,
  stripeCustomerId: string,
  subscription: SubscriptionRecord,
): Promise<void> {
  const meterEventName = process.env.STRIPE_METER_EVENT_NAME;
  if (!meterEventName) throw new Error('STRIPE_METER_EVENT_NAME env var is not set');

  const { subscriptionId, currentPeriodStart } = subscription;
  if (!subscriptionId || !currentPeriodStart) {
    console.warn(`${LOG} no billing period to report`, { orgId, stripeCustomerId });
    return;
  }

  try {
    await reportOrgUsage({
      orgId,
      subscriptionId,
      stripeCustomerId,
      currentPeriodStart,
      to: new Date().toISOString(),
      meterEventName,
    });
  } catch (err) {
    console.error(`${LOG} final usage report failed; continuing to cancel`, {
      orgId,
      stripeCustomerId,
      error: err,
    });
  }
}

async function cancellableSubscriptions(customerId: string): Promise<Stripe.Subscription[]> {
  const stripe = getStripeClient();
  try {
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 100,
    });
    return subscriptions.data.filter((s) => !SETTLED_STATUSES.has(s.status));
  } catch (err) {
    // The customer is already gone — the Stripe-triggered deletion flow.
    if (isStripeResourceMissing(err)) return [];
    throw err;
  }
}

/**
 * One attempt, then move on: a declined card must not wedge the teardown, and
 * the unpaid invoice survives in `open` for finance. Logged loudly — a failed
 * final charge is a revenue event, not a routine skip.
 */
async function collectFinalInvoices(
  customerId: string,
  subscriptionPaymentMethodIds: string[],
): Promise<void> {
  const stripe = getStripeClient();
  try {
    const drafts = await stripe.invoices.list({
      customer: customerId,
      status: 'draft',
      limit: 100,
    });
    if (drafts.data.length === 0) return;

    const paymentMethod = await resolvePaymentMethod(customerId, subscriptionPaymentMethodIds);
    for (const draft of drafts.data) {
      await collectInvoice(draft.id!, paymentMethod);
    }
  } catch (err) {
    console.error(`${LOG} final invoice collection failed; continuing to delete`, {
      customerId,
      error: err,
    });
  }
}

async function collectInvoice(invoiceId: string, paymentMethod: string | undefined): Promise<void> {
  const stripe = getStripeClient();
  const finalized = await stripe.invoices.finalizeInvoice(invoiceId);
  // finalizeInvoice auto-pays when a default card is on file.
  if (finalized.status === 'paid') return;
  await stripe.invoices.pay(invoiceId, paymentMethod ? { payment_method: paymentMethod } : {});
}

/**
 * Explicit, not left to Stripe: production sets the default on the
 * *subscription*, so relying on the customer's alone 402s and collects nothing.
 */
async function resolvePaymentMethod(
  customerId: string,
  subscriptionPaymentMethodIds: string[],
): Promise<string | undefined> {
  if (subscriptionPaymentMethodIds[0]) return subscriptionPaymentMethodIds[0];

  const stripe = getStripeClient();
  const customer = await stripe.customers.retrieve(customerId);
  if (!('deleted' in customer)) {
    const customerDefault = customer.invoice_settings?.default_payment_method;
    if (customerDefault) return idOf(customerDefault);
  }

  const attached = await stripe.paymentMethods.list({ customer: customerId, limit: 1 });
  return attached.data[0]?.id;
}

function defaultPaymentMethodOf(subscription: Stripe.Subscription): string[] {
  const method = subscription.default_payment_method;
  return method ? [idOf(method)] : [];
}

function idOf(value: string | { id: string }): string {
  return typeof value === 'string' ? value : value.id;
}
