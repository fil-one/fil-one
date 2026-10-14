// Re-export all shared helpers
export {
  getStripeClient,
  getDynamoClient,
  getBillingTableName,
  getUserInfoTableName,
  sleep,
  pollUntil,
  PollTimeoutError,
  seedBillingRecord,
  getBillingRecord,
  deleteBillingRecord,
  createTestCustomer,
  testOrgId,
} from '../helpers.js';

import { GetItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import {
  getStripeClient,
  getDynamoClient,
  getBillingTableName,
  pollUntil,
  PollTimeoutError,
  getBillingRecord,
  sleep,
  testOrgId,
} from '../helpers.js';
import { Resource } from 'sst';

// =============================================================================
// Stripe-webhook-specific helpers
// =============================================================================

export function getStripePriceId(): string {
  const priceId =
    process.env.STRIPE_PRICE_ID ??
    (Resource as unknown as Record<string, { value: string } | undefined>).StripePriceId?.value ??
    '';
  if (!priceId) {
    throw new Error('STRIPE_PRICE_ID is not set and not available from SST Resource');
  }
  return priceId;
}

export async function attachValidCard(customerId: string): Promise<string> {
  const pm = await getStripeClient().paymentMethods.attach('pm_card_visa', {
    customer: customerId,
  });
  await getStripeClient().customers.update(customerId, {
    invoice_settings: { default_payment_method: pm.id },
  });
  return pm.id;
}

export async function attachDecliningCard(customerId: string): Promise<string> {
  const pm = await getStripeClient().paymentMethods.attach('pm_card_chargeCustomerFail', {
    customer: customerId,
  });
  await getStripeClient().customers.update(customerId, {
    invoice_settings: { default_payment_method: pm.id },
  });
  return pm.id;
}

export async function createAndPayInvoice(customerId: string): Promise<string> {
  const stripeClient = getStripeClient();
  await stripeClient.invoiceItems.create({
    customer: customerId,
    amount: 500,
    currency: 'usd',
  });

  const invoice = await stripeClient.invoices.create({
    customer: customerId,
    pending_invoice_items_behavior: 'include',
  });

  await stripeClient.invoices.finalizeInvoice(invoice.id);
  await stripeClient.invoices.pay(invoice.id);

  return invoice.id;
}

export async function createAndFailInvoice(customerId: string): Promise<string> {
  const stripeClient = getStripeClient();
  await stripeClient.invoiceItems.create({
    customer: customerId,
    amount: 500,
    currency: 'usd',
  });

  const invoice = await stripeClient.invoices.create({
    customer: customerId,
    pending_invoice_items_behavior: 'include',
    auto_advance: false,
  });

  await stripeClient.invoices.finalizeInvoice(invoice.id);
  try {
    await getStripeClient().invoices.pay(invoice.id);
  } catch {
    console.debug('Expected invoice payment failure');
  }

  return invoice.id;
}

// =============================================================================
// Waiting
// =============================================================================

export async function pollForBillingStatusChange({
  userId,
  expectedStatus,
  fromStatus,
  timeoutMs = 30_000,
}: {
  userId: string;
  expectedStatus: string;
  fromStatus: string;
  timeoutMs?: number;
}): Promise<void> {
  await pollUntil(async () => {
    const record = await getBillingRecord(userId);
    if (!record) return null;
    const status = record.subscriptionStatus?.S;
    if (status === expectedStatus) return record;
    if (status === fromStatus) return null;
    throw new Error(
      `Unexpected subscriptionStatus "${status}" while polling for "${expectedStatus}" (from: "${fromStatus}")`,
    );
  }, timeoutMs);
}

export async function pollForPaymentMethod({
  userId,
  paymentMethodId,
  timeoutMs = 30_000,
}: {
  userId: string;
  paymentMethodId: string;
  timeoutMs?: number;
}): Promise<void> {
  await pollUntil(async () => {
    const record = await getBillingRecord(userId);
    if (!record) return null;
    const pmId = record.paymentMethodId?.S;
    if (pmId === paymentMethodId) return record;
    return null;
  }, timeoutMs);
}

export async function pollTestClockReady({
  clockId,
  timeoutSeconds = 270,
}: {
  clockId: string;
  timeoutSeconds?: number;
}): Promise<void> {
  let lastStatus: string | undefined;
  try {
    await pollUntil(
      async () => {
        const clockState = await getStripeClient().testHelpers.testClocks.retrieve(clockId);
        lastStatus = clockState.status;
        if (clockState.status === 'ready') return true;
        if (clockState.status === 'internal_failure') {
          throw new Error(`Test clock ${clockId} entered internal_failure state`);
        }
        return null;
      },
      timeoutSeconds * 1000,
      { initialDelay: 200 },
    );
  } catch (err) {
    if (err instanceof PollTimeoutError) {
      throw new Error(
        `pollTestClockReady timed out after ${timeoutSeconds}s ` +
          `(last status: ${lastStatus ?? 'unknown'}, clockId: ${clockId})`,
        { cause: err },
      );
    }
    throw err;
  }
}

// =============================================================================
// Subscriptions
// =============================================================================

/** A metered subscription carrying the metadata activation stamps on it. */
export async function createSubscription({
  userId,
  customerId,
  paymentMethodId,
  billingCycleAnchor,
}: {
  userId: string;
  customerId: string;
  paymentMethodId: string;
  billingCycleAnchor?: number;
}): Promise<string> {
  const sub = await getStripeClient().subscriptions.create({
    customer: customerId,
    items: [{ price: getStripePriceId() }],
    default_payment_method: paymentMethodId,
    metadata: { userId, orgId: testOrgId(userId) },
    ...(billingCycleAnchor
      ? { billing_cycle_anchor: billingCycleAnchor, proration_behavior: 'none' }
      : {}),
  });
  return sub.id;
}

/** Report metered usage so the next invoice is not zero, and wait for Stripe to ingest it. */
export async function reportUsage(customerId: string): Promise<void> {
  const stripe = getStripeClient();
  const price = await stripe.prices.retrieve(getStripePriceId());
  // The metered price names its meter; the Stripe types do not model the field.
  const meterId = (price.recurring as unknown as Record<string, string>).meter;
  const meter = await stripe.billing.meters.retrieve(meterId);
  // Stripe rejects events against an inactive meter with a cryptic "No active
  // meter found for event name X"; fail with guidance instead.
  if (meter.status !== 'active') {
    throw new Error(
      `Stripe Billing Meter "${meter.event_name}" (${meterId}) linked to price ` +
        `${getStripePriceId()} has status "${meter.status}" — expected "active".\n` +
        `Check the staging Stripe secrets in 1Password and ensure your stack's ` +
        `StripePriceId SST secret has the same value.`,
    );
  }
  await stripe.billing.meterEvents.create({
    event_name: meter.event_name,
    payload: { value: '1337', stripe_customer_id: customerId },
  });
  await sleep(15 * 1000);
}

/**
 * End the subscription now and settle the final invoice Stripe issues for its
 * last period. Returns the final invoice's id; a declined payment is expected
 * with a declining card.
 */
export async function cancelAndSettleFinalInvoice(subscriptionId: string): Promise<string> {
  const stripe = getStripeClient();
  const before = await stripe.invoices.list({ subscription: subscriptionId, limit: 100 });
  const seen = new Set(before.data.map((invoice) => invoice.id));

  await stripe.subscriptions.cancel(subscriptionId, { invoice_now: true });

  const after = await stripe.invoices.list({ subscription: subscriptionId, limit: 100 });
  const final = after.data.find((invoice) => !seen.has(invoice.id));
  if (!final?.id) throw new Error(`No final invoice for ${subscriptionId}`);

  if (final.status === 'draft') await stripe.invoices.finalizeInvoice(final.id);
  if (final.status !== 'paid') {
    try {
      await stripe.invoices.pay(final.id);
    } catch {
      console.debug('Expected final invoice payment failure');
    }
  }
  return final.id;
}

/** Advance the test clock past the subscription's period end, far enough for the renewal to be charged. */
export async function advancePastPeriodEnd(clockId: string, subscriptionId: string): Promise<void> {
  const stripe = getStripeClient();
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const periodEnd = sub.items.data[0].current_period_end;
  // Stripe finalizes a renewal invoice an hour after it drafts it.
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: periodEnd + 2 * 3600 });
  await pollTestClockReady({ clockId });
}

/**
 * The mark the webhook writes once it has queued the Stripe event about
 * `objectId`. Without it, a duplicate Stripe sends after the queue's 5-minute
 * dedup window would be handled again.
 */
export async function waitForWebhookMark(
  eventType: string,
  objectId: string,
): Promise<{ eventId: string; mark: Record<string, AttributeValue> }> {
  const eventId = await pollUntil(async () => {
    const { data } = await getStripeClient().events.list({ type: eventType, limit: 20 });
    // Every object an event carries has an id; Stripe types data.object as a
    // union that does not say so.
    const event = data.find((e) => (e.data.object as { id?: string }).id === objectId);
    return event?.id ?? null;
  }, 60_000);

  const mark = await pollUntil(async () => {
    const { Item } = await getDynamoClient().send(
      new GetItemCommand({
        TableName: getBillingTableName(),
        Key: { pk: { S: `WEBHOOK#${eventId}` }, sk: { S: 'EVENT' } },
      }),
    );
    return Item ?? null;
  }, 30_000);
  return { eventId, mark };
}

/**
 * Wait until the worker has had the Stripe event about `objectId` in hand: the
 * settle window after the webhook's mark covers the worker that consumes the
 * queue, so a test can assert that the event changed nothing.
 */
export async function waitForEventHandled(eventType: string, objectId: string): Promise<void> {
  await waitForWebhookMark(eventType, objectId);
  await sleep(10 * 1000);
}

/**
 * A subscription whose first renewal Stripe fails to charge: a declining card,
 * usage so the renewal is not zero, and the clock moved past the period end.
 */
export async function createPastDueSubscription({
  userId,
  customerId,
  clockId,
  paymentMethodId,
}: {
  userId: string;
  customerId: string;
  clockId: string;
  paymentMethodId: string;
}): Promise<string> {
  const clock = await getStripeClient().testHelpers.testClocks.retrieve(clockId);
  const subscriptionId = await createSubscription({
    userId,
    customerId,
    paymentMethodId,
    // A one-hour period keeps the clock advance short.
    billingCycleAnchor: clock.frozen_time + 3600,
  });
  await reportUsage(customerId);
  await advancePastPeriodEnd(clockId, subscriptionId);
  return subscriptionId;
}

/** A test clock anchored at now, so meter events Stripe receives fall in the first period. */
export async function createTestClock(name: string): Promise<string> {
  const clock = await getStripeClient().testHelpers.testClocks.create({
    frozen_time: Math.floor(Date.now() / 1000),
    name: `${name}-${crypto.randomUUID()}`,
  });
  return clock.id;
}
