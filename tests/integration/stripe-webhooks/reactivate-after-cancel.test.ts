import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  attachValidCard,
  createSubscription,
  createTestCustomer,
  deleteBillingRecord,
  getBillingRecord,
  getStripeClient,
  pollForBillingStatusChange,
  pollForPaymentMethod,
  seedBillingRecord,
  testOrgId,
} from './helpers.js';

describe('Reactivation after cancellation (customer.subscription.created)', () => {
  let userId: string;
  let cusId: string;
  let paymentMethodId: string;

  beforeAll(async () => {
    userId = `test-rac-${crypto.randomUUID()}`;
    cusId = await createTestCustomer(userId);
    await seedBillingRecord(userId, cusId, 'grace_period', {
      subscriptionId: { S: 'any-ended-subscription' },
      canceledAt: { S: new Date().toISOString() },
      gracePeriodEndsAt: { S: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() },
    });
    paymentMethodId = await attachValidCard(cusId);
    await pollForPaymentMethod({ userId, paymentMethodId });
  });

  afterAll(async () => {
    await getStripeClient().customers.del(cusId);
    await deleteBillingRecord(userId);
  });

  it("activates the new subscription and clears the ended one's grace fields", async () => {
    const subId = await createSubscription({ userId, customerId: cusId, paymentMethodId });
    await pollForBillingStatusChange({
      userId,
      expectedStatus: 'active',
      fromStatus: 'grace_period',
    });

    expect(await getBillingRecord(userId)).toStrictEqual({
      pk: { S: `ORG#${testOrgId(userId)}` },
      sk: { S: 'SUBSCRIPTION' },
      orgId: { S: testOrgId(userId) },
      userId: { S: userId },
      stripeCustomerId: { S: cusId },
      subscriptionId: { S: subId },
      subscriptionStatus: { S: 'active' },
      currentPeriodStart: { S: expect.any(String) },
      currentPeriodEnd: { S: expect.any(String) },
      updatedAt: { S: expect.any(String) },
      paymentMethodBrand: { S: 'visa' },
      paymentMethodId: { S: paymentMethodId },
      paymentMethodLast4: { S: '4242' },
      paymentMethodExpYear: { N: expect.any(String) },
      paymentMethodExpMonth: { N: expect.any(String) },
    });
  });
});
