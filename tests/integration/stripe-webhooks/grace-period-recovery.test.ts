import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  createTestCustomer,
  attachValidCard,
  seedBillingRecord,
  createAndPayInvoice,
  deleteBillingRecord,
  getStripeClient,
  getBillingRecord,
  pollForPaymentMethod,
  waitForEventHandled,
} from './helpers.js';

// A row in grace names a subscription Stripe has ended, and an ended
// subscription never comes back, so no paid invoice may revive the row.
// Reactivation creates a new subscription instead (reactivate-after-cancel).
describe('Grace Period (invoice.payment_succeeded)', () => {
  let userId: string;
  let cusId: string;

  beforeAll(async () => {
    userId = `test-gpr-${crypto.randomUUID()}`;
    cusId = await createTestCustomer(userId);
    await seedBillingRecord(userId, cusId, 'grace_period', {
      gracePeriodEndsAt: { S: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() },
      canceledAt: { S: new Date().toISOString() },
    });
    const paymentMethodId = await attachValidCard(cusId);
    await pollForPaymentMethod({ userId, paymentMethodId });
  });

  afterAll(async () => {
    await getStripeClient().customers.del(cusId);
    await deleteBillingRecord(userId);
  });

  it('leaves the row in grace when an invoice is paid', async () => {
    const before = await getBillingRecord(userId);

    const invoiceId = await createAndPayInvoice(cusId);
    await waitForEventHandled('invoice.payment_succeeded', invoiceId);

    expect(await getBillingRecord(userId)).toStrictEqual(before);
  });
});
