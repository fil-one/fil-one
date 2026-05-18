import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  createTestCustomer,
  seedBillingRecord,
  deleteBillingRecord,
  getStripePriceId,
  getStripeClient,
  pollForBillingStatusChange,
  getBillingRecord,
} from './helpers.js';

describe('Trial Canceled (customer.subscription.deleted)', () => {
  let userId: string;
  let cusId: string;
  let subId: string;

  beforeAll(async () => {
    userId = `test-tc-${crypto.randomUUID()}`;
    cusId = await createTestCustomer(userId);
    await seedBillingRecord(userId, cusId, 'trialing');
  });

  afterAll(async () => {
    await getStripeClient().customers.del(cusId);
    await deleteBillingRecord(userId);
  });

  it('should set status to grace_period with ~7-day grace window', async () => {
    const trialEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    const stripe = getStripeClient();
    const sub = await stripe.subscriptions.create({
      customer: cusId,
      items: [{ price: getStripePriceId() }],
      trial_end: trialEnd,
      metadata: { userId, orgId: 'test-org' },
      trial_settings: {
        end_behavior: { missing_payment_method: 'cancel' },
      },
    });
    subId = sub.id;

    await stripe.subscriptions.cancel(subId);

    await pollForBillingStatusChange({
      userId,
      expectedStatus: 'grace_period',
      fromStatus: 'trialing',
    });

    const record = await getBillingRecord(userId);
    expect(record).toMatchObject({
      pk: { S: `CUSTOMER#${userId}` },
      sk: { S: 'SUBSCRIPTION' },
      orgId: { S: 'test-org' },
      stripeCustomerId: { S: cusId },
      subscriptionStatus: { S: 'grace_period' },
      updatedAt: { S: expect.any(String) },
      gracePeriodEndsAt: { S: expect.any(String) },
      canceledAt: { S: expect.any(String) },
    });

    // Verify grace period is ~7 days from now
    const graceEnd = new Date(record!.gracePeriodEndsAt!.S!).getTime();
    const nowMs = Date.now();
    const diffDays = Math.floor((graceEnd - nowMs) / (86400 * 1000));
    expect(diffDays).toBeGreaterThanOrEqual(6);
    expect(diffDays).toBeLessThanOrEqual(8);
  });
});
