import { describe, it, afterAll, expect } from 'vitest';
import type Stripe from 'stripe';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { createOrUpdateSubscription } from '@filone/backend/src/lib/reactivate-subscription.ts';
import type { SubscriptionRecord } from '@filone/backend/src/lib/dynamo-records.ts';
import {
  attachDecliningCard,
  attachValidCard,
  createPastDueSubscription,
  createSubscription,
  createTestClock,
  createTestCustomer,
  deleteBillingRecord,
  getBillingRecord,
  getStripeClient,
  getStripePriceId,
  pollForBillingStatusChange,
  pollForPaymentMethod,
  seedBillingRecord,
  testOrgId,
  waitForEventHandled,
} from './helpers.js';

// Activation runs here against Stripe test mode, the way the activate handler
// calls it; the stage's webhook then moves the row, as it does after a real
// activation.

const LIVE_STATUSES = new Set(['trialing', 'active', 'past_due', 'unpaid', 'paused']);

/** The customer's subscriptions Stripe can still bill. */
async function liveSubscriptions(customerId: string): Promise<{ id: string; status: string }[]> {
  const { data } = await getStripeClient().subscriptions.list({
    customer: customerId,
    status: 'all',
  });
  return data
    .filter((subscription) => LIVE_STATUSES.has(subscription.status))
    .map(({ id, status }) => ({ id, status }));
}

/** Put the row in grace naming `subscriptionId`, once Stripe's own events for it have landed. */
async function seedGraceRow(userId: string, customerId: string, subscriptionId: string) {
  await waitForEventHandled('customer.subscription.created', subscriptionId);
  await seedBillingRecord(userId, customerId, 'grace_period', {
    subscriptionId: { S: subscriptionId },
    gracePeriodEndsAt: { S: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() },
  });
}

async function reactivate(userId: string, paymentMethodId: string) {
  // The row as the activate handler reads it from the store.
  const record = unmarshall((await getBillingRecord(userId))!) as SubscriptionRecord;
  return createOrUpdateSubscription({
    stripe: getStripeClient(),
    record,
    paymentMethodId,
    priceId: getStripePriceId(),
    userId,
    orgId: testOrgId(userId),
  });
}

describe('Reactivation from grace_period', () => {
  const cleanups: (() => Promise<unknown>)[] = [];

  afterAll(async () => {
    for (const cleanup of cleanups) await cleanup();
  });

  async function newOrg(prefix: string, clockId?: string) {
    const userId = `test-${prefix}-${crypto.randomUUID()}`;
    const customerId = await createTestCustomer(userId, clockId);
    await seedBillingRecord(userId, customerId, 'active');
    cleanups.push(
      () =>
        clockId
          ? getStripeClient().testHelpers.testClocks.del(clockId)
          : getStripeClient().customers.del(customerId),
      () => deleteBillingRecord(userId),
    );
    return { userId, customerId };
  }

  it('ends the trial on the subscription the row names when Stripe still has it trialing', async () => {
    const { userId, customerId } = await newOrg('rfg-trial');
    const stripe = getStripeClient();
    const { id: subscriptionId } = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: getStripePriceId() }],
      trial_end: Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60,
      trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
      metadata: { userId, orgId: testOrgId(userId) },
    });
    await seedGraceRow(userId, customerId, subscriptionId);
    const paymentMethodId = await attachValidCard(customerId);
    await pollForPaymentMethod({ userId, paymentMethodId });

    const result = await reactivate(userId, paymentMethodId);

    expect(result).toMatchObject({ ok: true, value: { id: subscriptionId, status: 'active' } });
    expect(await liveSubscriptions(customerId)).toStrictEqual([
      { id: subscriptionId, status: 'active' },
    ]);
    await pollForBillingStatusChange({
      userId,
      expectedStatus: 'active',
      fromStatus: 'grace_period',
    });
    expect(await getBillingRecord(userId)).toMatchObject({ subscriptionId: { S: subscriptionId } });
  });

  it('pays the open invoice of the past-due subscription the row names with the new card', async () => {
    const clockId = await createTestClock('reactivate-past-due');
    const { userId, customerId } = await newOrg('rfg-pd', clockId);
    const decliningId = await attachDecliningCard(customerId);
    await pollForPaymentMethod({ userId, paymentMethodId: decliningId });
    const subscriptionId = await createPastDueSubscription({
      userId,
      customerId,
      clockId,
      paymentMethodId: decliningId,
    });
    await pollForBillingStatusChange({ userId, expectedStatus: 'past_due', fromStatus: 'active' });
    await seedGraceRow(userId, customerId, subscriptionId);
    const paymentMethodId = await attachValidCard(customerId);
    await pollForPaymentMethod({ userId, paymentMethodId });

    const result = await reactivate(userId, paymentMethodId);

    expect(result).toMatchObject({ ok: true, value: { id: subscriptionId, status: 'active' } });
    expect(await liveSubscriptions(customerId)).toStrictEqual([
      { id: subscriptionId, status: 'active' },
    ]);
    const { data: openInvoices } = await getStripeClient().invoices.list({
      subscription: subscriptionId,
      status: 'open',
    });
    expect(openInvoices).toStrictEqual([]);
    await pollForBillingStatusChange({
      userId,
      expectedStatus: 'active',
      fromStatus: 'grace_period',
    });
  }, 420_000);

  it('creates one new subscription when the subscription the row names is canceled', async () => {
    const { userId, customerId } = await newOrg('rfg-canceled');
    const firstCard = await attachValidCard(customerId);
    await pollForPaymentMethod({ userId, paymentMethodId: firstCard });
    const endedId = await createSubscription({ userId, customerId, paymentMethodId: firstCard });
    await waitForEventHandled('customer.subscription.created', endedId);
    await getStripeClient().subscriptions.cancel(endedId);
    await waitForEventHandled('customer.subscription.deleted', endedId);
    await seedBillingRecord(userId, customerId, 'grace_period', {
      subscriptionId: { S: endedId },
      canceledAt: { S: new Date().toISOString() },
      gracePeriodEndsAt: { S: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() },
    });

    const result = await reactivate(userId, firstCard);

    expect(result).toMatchObject({ ok: true, value: { status: 'active' } });
    const createdId = (result as { value: Stripe.Subscription }).value.id;
    expect(createdId).not.toBe(endedId);
    expect(await liveSubscriptions(customerId)).toStrictEqual([
      { id: createdId, status: 'active' },
    ]);
  });

  it('refuses with 409 and creates nothing when the customer has a live subscription the row does not name', async () => {
    const { userId, customerId } = await newOrg('rfg-stray');
    const paymentMethodId = await attachValidCard(customerId);
    await pollForPaymentMethod({ userId, paymentMethodId });
    const strayId = await createSubscription({ userId, customerId, paymentMethodId });
    await waitForEventHandled('customer.subscription.created', strayId);
    // The row names a subscription Stripe never had, so activation would create.
    await seedBillingRecord(userId, customerId, 'grace_period', {
      subscriptionId: { S: 'sub_unknown_to_stripe' },
    });

    const result = await reactivate(userId, paymentMethodId);

    expect(result).toMatchObject({ ok: false, refusal: { statusCode: 409 } });
    expect(await liveSubscriptions(customerId)).toStrictEqual([{ id: strayId, status: 'active' }]);
  });
});
