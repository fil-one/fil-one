import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  createTestCustomer,
  deleteBillingRecord,
  deliverToStripeEventWorker,
  getBillingRecord,
  getStripeClient,
  getStripePriceId,
  seedBillingRecord,
  testOrgId,
} from './helpers.js';

// Stripe does not deliver events in order. A trial canceled right after it was
// created can have its customer.subscription.created reach the worker after
// customer.subscription.deleted. The late event must not take the row out of
// its grace period.
describe('A late customer.subscription.created after the cancellation', () => {
  let userId: string;
  let cusId: string;

  beforeAll(async () => {
    userId = `test-lca-${crypto.randomUUID()}`;
    cusId = await createTestCustomer(userId);
    // A trial row that names no subscription yet, like the pre-activation
    // trial cohort in production.
    await seedBillingRecord(userId, cusId, 'trialing');

    // The worker looks the subscription up in Stripe, so it has to exist. Its
    // own webhooks also reach the worker, in whatever order Stripe picks; the
    // deliveries below put the late event last regardless.
    const stripe = getStripeClient();
    const created = await stripe.subscriptions.create({
      customer: cusId,
      items: [{ price: getStripePriceId() }],
      trial_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
      metadata: { userId, orgId: testOrgId(userId) },
    });
    const ended = await stripe.subscriptions.cancel(created.id);

    await deliverToStripeEventWorker({
      id: `evt_test_${crypto.randomUUID()}`,
      type: 'customer.subscription.deleted',
      data: { object: ended },
    });
    await deliverToStripeEventWorker({
      id: `evt_test_${crypto.randomUUID()}`,
      type: 'customer.subscription.created',
      data: { object: created },
    });
  }, 60_000);

  afterAll(async () => {
    await getStripeClient().customers.del(cusId);
    await deleteBillingRecord(userId);
  });

  it('keeps the row in its grace period', async () => {
    const record = await getBillingRecord(userId);
    expect(record).toMatchObject({
      subscriptionStatus: { S: 'grace_period' },
      canceledAt: { S: expect.any(String) },
      gracePeriodEndsAt: { S: expect.any(String) },
    });
  });
});
