import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  createTestCustomer,
  attachDecliningCard,
  seedBillingRecord,
  createAndFailInvoice,
  sleep,
  getBillingRecord,
  deleteBillingRecord,
  getStripeClient,
} from './helpers.js';

describe('Payment Failure (invoice.payment_failed)', () => {
  let userId: string;
  let cusId: string;

  beforeAll(async () => {
    userId = `test-pf-${crypto.randomUUID()}`;
    cusId = await createTestCustomer(userId);
    await attachDecliningCard(cusId);
    await seedBillingRecord(userId, cusId, 'active');
  });

  afterAll(async () => {
    await getStripeClient().customers.del(cusId);
    await deleteBillingRecord(userId);
  });

  it('should set status to past_due and record failure timestamp', async () => {
    await createAndFailInvoice(cusId);
    await sleep(15 * 1000);
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
