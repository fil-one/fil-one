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

describe('Grace Period Recovery (invoice.payment_succeeded)', () => {
  let userId: string;
  let cusId: string;

  beforeAll(async () => {
    userId = `test-gpr-${crypto.randomUUID()}`;
    cusId = await createTestCustomer(userId);
    await attachValidCard(cusId);

    const graceEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const canceledAt = new Date().toISOString();
    await seedBillingRecord(userId, cusId, 'grace_period', {
      gracePeriodEndsAt: { S: graceEnd },
      canceledAt: { S: canceledAt },
    });
  });

  afterAll(async () => {
    await getStripeClient().customers.del(cusId);
    await deleteBillingRecord(userId);
  });

  it('should restore status to active and clear grace period fields', async () => {
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
