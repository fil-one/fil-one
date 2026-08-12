import type Stripe from 'stripe';
import type { DeletionMember } from './deletion-record.js';
import { getStripeClient, isStripeResourceMissing } from './stripe-client.js';

/** Statuses with nothing left to cancel or invoice. */
const SETTLED_STATUSES = new Set<Stripe.Subscription.Status>(['canceled', 'incomplete_expired']);

/**
 * Bills what is owed, collects it once, then deletes the customer. The delete is
 * the whole erasure — per Stripe it "removes all credit card details and
 * prevents any further operations", taking email and metadata with it — so there
 * is no field-clearing or detach step. Only ordering constraint:
 * collect-before-delete.
 *
 * Not billed: storage since the last 12-hourly usage report. Metering it needs
 * usage-reporting-worker's path, which is not callable in isolation today, and
 * up to 12 hours of unbilled storage per deleted org beats blocking deletion on
 * a refactor.
 */
export async function tearDownStripe(members: DeletionMember[]): Promise<void> {
  for (const { stripeCustomerId } of members) {
    // Absent is legal — an org that never onboarded.
    if (stripeCustomerId) await tearDownCustomer(stripeCustomerId);
  }
}

async function tearDownCustomer(customerId: string): Promise<void> {
  const stripe = getStripeClient();

  // customers.del cancels subscriptions too, but silently and without an
  // invoice — this explicit cancel is what makes the usage billable.
  const paymentMethodIds: string[] = [];
  for (const subscription of await cancellableSubscriptions(customerId)) {
    paymentMethodIds.push(...defaultPaymentMethodOf(subscription));
    await stripe.subscriptions.cancel(subscription.id, { invoice_now: true, prorate: false });
  }

  await collectFinalInvoices(customerId, paymentMethodIds);

  try {
    await stripe.customers.del(customerId);
  } catch (err) {
    // Probed: a repeat delete 404s, so every re-drive lands here.
    if (!isStripeResourceMissing(err)) throw err;
  }
}

async function cancellableSubscriptions(customerId: string): Promise<Stripe.Subscription[]> {
  const stripe = getStripeClient();
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 100,
  });
  return subscriptions.data.filter((s) => !SETTLED_STATUSES.has(s.status));
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
