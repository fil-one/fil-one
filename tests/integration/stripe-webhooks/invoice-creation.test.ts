import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  createTestCustomer,
  attachValidCard,
  seedBillingRecord,
  createAndPayInvoice,
  deleteBillingRecord,
  getStripeClient,
  pollForBillingStatusChange,
  pollForPaymentMethod,
  getBillingRecord,
} from './helpers.js';

describe('Invoice Creation (invoice.payment_succeeded)', () => {
  let userId: string;
  let cusId: string;

  beforeAll(async () => {
    userId = `test-ic-${crypto.randomUUID()}`;
    cusId = await createTestCustomer(userId);
    await seedBillingRecord(userId, cusId, 'past_due', {
      lastPaymentFailedAt: { S: '2024-01-01T00:00:00Z' },
    });
    const paymentMethodId = await attachValidCard(cusId);
    await pollForPaymentMethod({ userId, paymentMethodId });
  });

  afterAll(async () => {
    await getStripeClient().customers.del(cusId);
    await deleteBillingRecord(userId);
  });

  it('should set status to active and clear failure fields', async () => {
    await createAndPayInvoice(cusId);
    await pollForBillingStatusChange({
      userId,
      expectedStatus: 'active',
      fromStatus: 'past_due',
    });
    const record = await getBillingRecord(userId);
    expect(record).toStrictEqual({
      pk: { S: `CUSTOMER#${userId}` },
      sk: { S: 'SUBSCRIPTION' },
      orgId: { S: 'test-org' },
      stripeCustomerId: { S: cusId },
      subscriptionStatus: { S: 'active' },
      updatedAt: { S: expect.any(String) },
      lastPaymentAt: { S: expect.any(String) },
      paymentMethodBrand: { S: 'visa' },
      paymentMethodId: { S: expect.any(String) },
      paymentMethodLast4: { S: '4242' },
      paymentMethodExpYear: { N: expect.any(String) },
      paymentMethodExpMonth: { N: expect.any(String) },
    });
  });
});
