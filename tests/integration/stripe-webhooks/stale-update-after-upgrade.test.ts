import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  attachValidCard,
  createTestCustomer,
  deleteBillingRecord,
  deliverToStripeEventWorker,
  getBillingRecord,
  getStripeClient,
  getStripePriceId,
  pollForBillingStatusChange,
  pollForPaymentMethod,
  pollUntil,
  seedBillingRecord,
  testOrgId,
} from './helpers.js';

// Upgrade updates the subscription twice, milliseconds apart: first its
// default payment method, while it is still trialing, then trial_end: 'now',
// which makes it active. Stripe can deliver the first update last. That late
// event must not put the paying org back on its trial.
describe('A late customer.subscription.updated from before the upgrade', () => {
  let userId: string;
  let cusId: string;

  beforeAll(async () => {
    userId = `test-sua-${crypto.randomUUID()}`;
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
    await pollUntil(
      async () => ((await getBillingRecord(userId))?.subscriptionId?.S === sub.id ? true : null),
      30_000,
    );

    // The same two calls Upgrade makes (activate-subscription.ts).
    const paymentMethodId = await attachValidCard(cusId);
    await pollForPaymentMethod({ userId, paymentMethodId });
    const staleSubscription = await stripe.subscriptions.update(sub.id, {
      default_payment_method: paymentMethodId,
    });
    if (staleSubscription.status !== 'trialing') {
      throw new Error(
        `Expected the pre-upgrade update to be trialing, got ${staleSubscription.status}`,
      );
    }
    await stripe.subscriptions.update(sub.id, { trial_end: 'now' });
    await pollForBillingStatusChange({ userId, expectedStatus: 'active', fromStatus: 'trialing' });

    await deliverToStripeEventWorker({
      id: `evt_test_${crypto.randomUUID()}`,
      type: 'customer.subscription.updated',
      data: { object: staleSubscription },
    });
  }, 120_000);

  afterAll(async () => {
    await getStripeClient().customers.del(cusId);
    await deleteBillingRecord(userId);
  });

  it('keeps the row active', async () => {
    const record = await getBillingRecord(userId);
    expect(record).toMatchObject({ subscriptionStatus: { S: 'active' } });
  });
});
