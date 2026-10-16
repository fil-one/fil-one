import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  createTestClock,
  createTestCustomer,
  createPastDueSubscription,
  attachDecliningCard,
  attachValidCard,
  seedBillingRecord,
  deleteBillingRecord,
  getStripeClient,
  pollForBillingStatusChange,
  pollForPaymentMethod,
  getBillingRecord,
  testOrgId,
} from './helpers.js';

describe('Past Due Recovery (customer.subscription.updated to active)', () => {
  let userId: string;
  let cusId: string;
  let clockId: string;
  let subId: string;

  beforeAll(async () => {
    userId = `test-pdr-${crypto.randomUUID()}`;
    clockId = await createTestClock('past-due-recovery');
    cusId = await createTestCustomer(userId, clockId);
    await seedBillingRecord(userId, cusId, 'active');
    const decliningId = await attachDecliningCard(cusId);
    await pollForPaymentMethod({ userId, paymentMethodId: decliningId });

    subId = await createPastDueSubscription({
      userId,
      customerId: cusId,
      clockId,
      paymentMethodId: decliningId,
    });
    await pollForBillingStatusChange({ userId, expectedStatus: 'past_due', fromStatus: 'active' });
  }, 420_000);

  afterAll(async () => {
    // Deleting the clock deletes its customer and subscriptions with it.
    await getStripeClient().testHelpers.testClocks.del(clockId);
    await deleteBillingRecord(userId);
  });

  it('restores active once the open renewal is paid with a working card', async () => {
    const stripe = getStripeClient();
    const paymentMethodId = await attachValidCard(cusId);
    await pollForPaymentMethod({ userId, paymentMethodId });
    const { latest_invoice: invoiceId } = await stripe.subscriptions.retrieve(subId);
    if (typeof invoiceId !== 'string') throw new Error(`No open invoice on ${subId}`);
    await stripe.invoices.pay(invoiceId, { payment_method: paymentMethodId });

    await pollForBillingStatusChange({ userId, expectedStatus: 'active', fromStatus: 'past_due' });
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
