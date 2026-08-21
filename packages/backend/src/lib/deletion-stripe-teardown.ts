import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import type Stripe from 'stripe';
import { getDynamoClient } from './ddb-client.js';
import type { DeletionMember } from './deletion-record.js';
import { reportOrgUsage } from './org-usage-report.js';
import { syncTenantStatusInProvisionedRegions } from './region-helpers.js';
import { getStripeClient, isStripeResourceMissing } from './stripe-client.js';

/** Statuses with nothing left to cancel or invoice. */
const SETTLED_STATUSES = new Set<Stripe.Subscription.Status>(['canceled', 'incomplete_expired']);

/**
 * Disables the tenants, bills what is owed, collects it once, then deletes the
 * customer. The delete is the whole erasure — per Stripe it "removes all credit
 * card details and prevents any further operations", taking email and metadata
 * with it — so there is no field-clearing or detach step.
 *
 * The disable comes first so the meter is not moving underneath the figure the
 * customer is billed for. A request already in flight when it lands can still add
 * its last writes, and that residue goes unbilled; it is bounded by a request
 * timeout measured in seconds.
 *
 * Every step treats a missing or already-deleted customer as success, because a
 * deletion triggered by the customer's deletion in Stripe finds it already gone.
 */
export async function tearDownStripe(orgId: string, members: DeletionMember[]): Promise<void> {
  await syncTenantStatusInProvisionedRegions(orgId, 'disabled');

  for (const { userId, stripeCustomerId } of members) {
    // Absent is legal — an org that never onboarded.
    if (stripeCustomerId) await tearDownCustomer(orgId, userId, stripeCustomerId);
  }
}

async function tearDownCustomer(orgId: string, userId: string, customerId: string): Promise<void> {
  const stripe = getStripeClient();

  const subscriptions = await cancellableSubscriptions(customerId);

  // Before the cancel: a meter event after cancellation lands on no invoice.
  await reportOutstandingUsage(orgId, userId, customerId);

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
  userId: string,
  stripeCustomerId: string,
): Promise<void> {
  const meterEventName = process.env.STRIPE_METER_EVENT_NAME;
  if (!meterEventName) throw new Error('STRIPE_METER_EVENT_NAME env var is not set');

  try {
    const { Item } = await getDynamoClient().send(
      new GetItemCommand({
        TableName: Resource.BillingTable.name,
        Key: { pk: { S: `CUSTOMER#${userId}` }, sk: { S: 'SUBSCRIPTION' } },
        ProjectionExpression: 'subscriptionId, currentPeriodStart',
        ConsistentRead: true,
      }),
    );
    const subscriptionId = Item?.subscriptionId?.S;
    const currentPeriodStart = Item?.currentPeriodStart?.S;
    if (!subscriptionId || !currentPeriodStart) {
      console.warn('[deletion-stripe] no billing period to report', { orgId, stripeCustomerId });
      return;
    }

    await reportOrgUsage({
      orgId,
      subscriptionId,
      stripeCustomerId,
      currentPeriodStart,
      to: new Date().toISOString(),
      meterEventName,
    });
  } catch (err) {
    console.error('[deletion-stripe] final usage report failed; continuing to cancel', {
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
    console.error('[deletion-stripe] final invoice collection failed; continuing to delete', {
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
