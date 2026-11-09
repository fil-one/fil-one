import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  createTestCustomer,
  deleteBillingRecord,
  deliverToStripeEventWorker,
  getBillingRecord,
  getStripeClient,
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

    // The worker reads only these fields, so no Stripe subscription is created:
    // a real one would send its own webhooks in whatever order Stripe picks.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const trialEnd = nowSeconds + 30 * 24 * 60 * 60;
    const subscription = {
      id: `sub_test_${crypto.randomUUID()}`,
      object: 'subscription',
      customer: cusId,
      metadata: { userId, orgId: testOrgId(userId) },
      trial_end: trialEnd,
      items: { data: [{ current_period_start: nowSeconds, current_period_end: trialEnd }] },
    };

    await deliverToStripeEventWorker({
      id: `evt_test_${crypto.randomUUID()}`,
      type: 'customer.subscription.deleted',
      data: {
        object: {
          ...subscription,
          status: 'canceled',
          ended_at: nowSeconds,
          cancellation_details: { reason: 'cancellation_requested' },
        },
      },
    });
    await deliverToStripeEventWorker({
      id: `evt_test_${crypto.randomUUID()}`,
      type: 'customer.subscription.created',
      data: { object: { ...subscription, status: 'trialing' } },
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
