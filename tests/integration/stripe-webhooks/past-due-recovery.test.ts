import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  createTestCustomer,
  attachValidCard,
  seedBillingRecord,
  createAndPayInvoice,
  sleep,
  getBillingRecord,
  deleteBillingRecord,
  getStripeClient,
} from './helpers.js';

describe('Past Due Recovery (invoice.payment_succeeded with canceledAt)', () => {
  let userId: string;
  let cusId: string;

  beforeAll(async () => {
    userId = `test-pdr-${crypto.randomUUID()}`;
    cusId = await createTestCustomer(userId);
    await attachValidCard(cusId);

    const canceledAt = new Date().toISOString();
    await seedBillingRecord(userId, cusId, 'past_due', {
      lastPaymentFailedAt: { S: '2024-01-01T00:00:00Z' },
      canceledAt: { S: canceledAt },
    });
  });

  afterAll(async () => {
    await getStripeClient().customers.del(cusId);
    await deleteBillingRecord(userId);
  });

  it('should restore status to active and clear all failure/cancel fields', async () => {
    await createAndPayInvoice(cusId);
    await sleep(15 * 1000);
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
