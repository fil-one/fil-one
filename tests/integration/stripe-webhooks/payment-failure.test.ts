import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  createTestCustomer,
  attachDecliningCard,
  seedBillingRecord,
  createAndFailInvoice,
  deleteBillingRecord,
  getStripeClient,
  pollForBillingStatusChange,
  pollForPaymentMethod,
  getBillingRecord,
} from './helpers.js';

describe('Payment Failure (invoice.payment_failed)', () => {
  let userId: string;
  let cusId: string;

  beforeAll(async () => {
    userId = `test-pf-${crypto.randomUUID()}`;
    cusId = await createTestCustomer(userId);
    await seedBillingRecord(userId, cusId, 'active');
    const paymentMethodId = await attachDecliningCard(cusId);
    await pollForPaymentMethod({ userId, paymentMethodId });
  });

  afterAll(async () => {
    await getStripeClient().customers.del(cusId);
    await deleteBillingRecord(userId);
  });

  it('should set status to past_due and record failure timestamp', async () => {
    await createAndFailInvoice(cusId);
    await pollForBillingStatusChange({
      userId,
      expectedStatus: 'past_due',
      fromStatus: 'active',
    });
    const record = await getBillingRecord(userId);
    expect(record).toStrictEqual({
      pk: { S: `CUSTOMER#${userId}` },
      sk: { S: 'SUBSCRIPTION' },
      orgId: { S: 'test-org' },
      stripeCustomerId: { S: cusId },
      subscriptionStatus: { S: 'past_due' },
      updatedAt: { S: expect.any(String) },
      lastPaymentFailedAt: { S: expect.any(String) },
      paymentMethodBrand: { S: 'visa' },
      paymentMethodId: { S: expect.any(String) },
      paymentMethodLast4: { S: '0341' }, // last4 numbers for declined after attach test card
      paymentMethodExpYear: { N: expect.any(String) },
      paymentMethodExpMonth: { N: expect.any(String) },
    });
  });
});
