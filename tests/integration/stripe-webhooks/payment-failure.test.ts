import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  createTestClock,
  createTestCustomer,
  createPastDueSubscription,
  attachDecliningCard,
  seedBillingRecord,
  createAndFailInvoice,
  deleteBillingRecord,
  getStripeClient,
  pollForBillingStatusChange,
  pollForPaymentMethod,
  getBillingRecord,
  testOrgId,
  waitForWebhookMark,
} from './helpers.js';

describe('Payment Failure (customer.subscription.updated to past_due)', () => {
  let userId: string;
  let cusId: string;
  let clockId: string;
  let paymentMethodId: string;

  beforeAll(async () => {
    userId = `test-pf-${crypto.randomUUID()}`;
    clockId = await createTestClock('payment-failure');
    cusId = await createTestCustomer(userId, clockId);
    await seedBillingRecord(userId, cusId, 'active');
    paymentMethodId = await attachDecliningCard(cusId);
    await pollForPaymentMethod({ userId, paymentMethodId });
  });

  afterAll(async () => {
    // Deleting the clock deletes its customer and subscriptions with it.
    await getStripeClient().testHelpers.testClocks.del(clockId);
    await deleteBillingRecord(userId);
  });

  it('sets past_due when Stripe fails to charge a renewal', async () => {
    const subId = await createPastDueSubscription({
      userId,
      customerId: cusId,
      clockId,
      paymentMethodId,
    });
    await pollForBillingStatusChange({ userId, expectedStatus: 'past_due', fromStatus: 'active' });

    expect(await getBillingRecord(userId)).toStrictEqual({
      pk: { S: `ORG#${testOrgId(userId)}` },
      sk: { S: 'SUBSCRIPTION' },
      orgId: { S: testOrgId(userId) },
      userId: { S: userId },
      stripeCustomerId: { S: cusId },
      subscriptionId: { S: subId },
      subscriptionStatus: { S: 'past_due' },
      currentPeriodStart: { S: expect.any(String) },
      currentPeriodEnd: { S: expect.any(String) },
      updatedAt: { S: expect.any(String) },
      paymentMethodBrand: { S: 'visa' },
      paymentMethodId: { S: paymentMethodId },
      paymentMethodLast4: { S: '0341' }, // last4 numbers for declined after attach test card
      paymentMethodExpYear: { N: expect.any(String) },
      paymentMethodExpMonth: { N: expect.any(String) },
    });
  }, 420_000);

  it('marks a received event so a later duplicate is dropped', async () => {
    const invoiceId = await createAndFailInvoice(cusId);

    const { eventId, mark } = await waitForWebhookMark('invoice.payment_failed', invoiceId);

    expect(mark).toStrictEqual({
      pk: { S: `WEBHOOK#${eventId}` },
      sk: { S: 'EVENT' },
      eventType: { S: 'invoice.payment_failed' },
      processedAt: { S: expect.any(String) },
      ttl: { N: expect.any(String) },
    });
  });
});
