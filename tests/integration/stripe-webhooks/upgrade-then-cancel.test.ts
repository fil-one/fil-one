import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  attachValidCard,
  createTestCustomer,
  deleteBillingRecord,
  getBillingRecord,
  getStripeClient,
  getStripePriceId,
  pollForBillingStatusChange,
  pollForPaymentMethod,
  pollUntil,
  seedBillingRecord,
  testOrgId,
} from './helpers.js';

// Upgrade ends the trial with trial_end: 'now', and Stripe keeps that
// timestamp. Cancelling the paid subscription must still grant the 30 days of
// grace a paying org gets.
describe('Cancellation after upgrading from the trial', () => {
  let userId: string;
  let cusId: string;
  let subId: string;

  beforeAll(async () => {
    userId = `test-utc-${crypto.randomUUID()}`;
    cusId = await createTestCustomer(userId);
    await seedBillingRecord(userId, cusId, 'trialing');

    const stripe = getStripeClient();
    const sub = await stripe.subscriptions.create({
      customer: cusId,
      items: [{ price: getStripePriceId() }],
      trial_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
      metadata: { userId, orgId: testOrgId(userId) },
    });
    subId = sub.id;
    await pollUntil(
      async () => ((await getBillingRecord(userId))?.subscriptionId?.S === subId ? true : null),
      30_000,
    );

    // The same two calls Upgrade makes (activate-subscription.ts).
    const paymentMethodId = await attachValidCard(cusId);
    await pollForPaymentMethod({ userId, paymentMethodId });
    await stripe.subscriptions.update(subId, { default_payment_method: paymentMethodId });
    await stripe.subscriptions.update(subId, { trial_end: 'now' });
    await pollForBillingStatusChange({ userId, expectedStatus: 'active', fromStatus: 'trialing' });
  }, 120_000);

  afterAll(async () => {
    await getStripeClient().customers.del(cusId);
    await deleteBillingRecord(userId);
  });

  it('grants 30 days of grace counted from when Stripe ended the subscription', async () => {
    const ended = await getStripeClient().subscriptions.cancel(subId);
    expect(ended.trial_end).toBeLessThanOrEqual(ended.ended_at!);

    await pollForBillingStatusChange({
      userId,
      expectedStatus: 'grace_period',
      fromStatus: 'active',
    });

    const record = await getBillingRecord(userId);
    const canceledAt = new Date(ended.ended_at! * 1000);
    expect(record?.canceledAt?.S).toBe(canceledAt.toISOString());
    expect(record?.gracePeriodEndsAt?.S).toBe(
      new Date(canceledAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    );
  });
});
