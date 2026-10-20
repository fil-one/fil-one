import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  attachValidCard,
  createTestClock,
  createTestCustomer,
  deleteBillingRecord,
  getBillingRecord,
  getStripeClient,
  getStripePriceId,
  pollForBillingStatusChange,
  pollForPaymentMethod,
  pollTestClockReady,
  pollUntil,
  seedBillingRecord,
  testOrgId,
} from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A one-day trial on the clock, created the way signup creates it. */
async function createTrial(userId: string, customerId: string, clockId: string) {
  const stripe = getStripeClient();
  const { frozen_time: clockNow } = await stripe.testHelpers.testClocks.retrieve(clockId);
  const sub = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: getStripePriceId() }],
    trial_end: clockNow + 24 * 60 * 60,
    trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
    metadata: { userId, orgId: testOrgId(userId) },
  });
  await pollUntil(
    async () => ((await getBillingRecord(userId))?.subscriptionId?.S === sub.id ? true : null),
    30_000,
  );
  return { subId: sub.id, trialEnd: sub.trial_end! };
}

async function advancePastTrialEnd(clockId: string, trialEnd: number): Promise<void> {
  await getStripeClient().testHelpers.testClocks.advance(clockId, {
    frozen_time: trialEnd + 2 * 3600,
  });
  await pollTestClockReady({ clockId });
}

// Stripe cancels a trial that ends with no card on file, and the org gets the
// 7 days of grace a trial gets, counted from when Stripe ended it.
describe.each([
  { rowAtExpiry: 'trialing', consoleMovedToGrace: false },
  // The console moves an expired trial into grace on the next request, often
  // before Stripe's cancellation is handled.
  { rowAtExpiry: 'grace_period', consoleMovedToGrace: true },
])('Trial expiry with no card (row $rowAtExpiry)', ({ consoleMovedToGrace }) => {
  let userId: string;
  let cusId: string;
  let clockId: string;
  let subId: string;
  let trialEnd: number;

  beforeAll(async () => {
    userId = `test-tex-${crypto.randomUUID()}`;
    clockId = await createTestClock('trial-expiry');
    cusId = await createTestCustomer(userId, clockId);
    await seedBillingRecord(userId, cusId, 'trialing');
    ({ subId, trialEnd } = await createTrial(userId, cusId, clockId));
    if (consoleMovedToGrace) {
      await seedBillingRecord(userId, cusId, 'grace_period', {
        subscriptionId: { S: subId },
        gracePeriodEndsAt: { S: new Date(trialEnd * 1000 + 7 * DAY_MS).toISOString() },
      });
    }
  }, 120_000);

  afterAll(async () => {
    // Deleting the clock deletes its customer and subscriptions with it.
    await getStripeClient().testHelpers.testClocks.del(clockId);
    await deleteBillingRecord(userId);
  });

  it('grants 7 days of grace from when Stripe ended the subscription', async () => {
    await advancePastTrialEnd(clockId, trialEnd);
    const ended = await getStripeClient().subscriptions.retrieve(subId);
    expect(ended.status).toBe('canceled');

    const record = await pollUntil(async () => {
      const row = await getBillingRecord(userId);
      return row?.canceledAt ? row : null;
    }, 60_000);
    const canceledAt = new Date(ended.ended_at! * 1000);
    expect(record.subscriptionStatus?.S).toBe('grace_period');
    expect(record.canceledAt?.S).toBe(canceledAt.toISOString());
    expect(record.gracePeriodEndsAt?.S).toBe(
      new Date(canceledAt.getTime() + 7 * DAY_MS).toISOString(),
    );
  });
});

// A card on file when the trial ends converts it into a paid subscription,
// which a later cancellation gives 30 days.
describe('Trial expiry with a card on file', () => {
  let userId: string;
  let cusId: string;
  let clockId: string;
  let subId: string;
  let trialEnd: number;

  beforeAll(async () => {
    userId = `test-tec-${crypto.randomUUID()}`;
    clockId = await createTestClock('trial-expiry-card');
    cusId = await createTestCustomer(userId, clockId);
    await seedBillingRecord(userId, cusId, 'trialing');
    const paymentMethodId = await attachValidCard(cusId);
    await pollForPaymentMethod({ userId, paymentMethodId });
    ({ subId, trialEnd } = await createTrial(userId, cusId, clockId));
  }, 120_000);

  afterAll(async () => {
    await getStripeClient().testHelpers.testClocks.del(clockId);
    await deleteBillingRecord(userId);
  });

  it('becomes active with no grace period', async () => {
    await advancePastTrialEnd(clockId, trialEnd);
    await pollForBillingStatusChange({ userId, expectedStatus: 'active', fromStatus: 'trialing' });

    const record = await getBillingRecord(userId);
    expect(record?.canceledAt).toBeUndefined();
    expect(record?.gracePeriodEndsAt).toBeUndefined();
  });

  it('grants 30 days of grace when it is canceled afterwards', async () => {
    const ended = await getStripeClient().subscriptions.cancel(subId);
    await pollForBillingStatusChange({
      userId,
      expectedStatus: 'grace_period',
      fromStatus: 'active',
    });

    const record = await getBillingRecord(userId);
    const canceledAt = new Date(ended.ended_at! * 1000);
    expect(record?.canceledAt?.S).toBe(canceledAt.toISOString());
    expect(record?.gracePeriodEndsAt?.S).toBe(
      new Date(canceledAt.getTime() + 30 * DAY_MS).toISOString(),
    );
  });
});
