import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  attachDecliningCard,
  attachValidCard,
  cancelAndSettleFinalInvoice,
  createSubscription,
  createTestCustomer,
  deleteBillingRecord,
  getBillingRecord,
  getStripeClient,
  pollForBillingStatusChange,
  pollForPaymentMethod,
  pollUntil,
  reportUsage,
  seedBillingRecord,
  testOrgId,
  waitForEventHandled,
} from './helpers.js';

// Stripe bills a metered subscription's last period after it ends the
// subscription. That final invoice must leave the org in grace, so the
// grace-period enforcer still locks and then disables it.
describe.each([
  {
    outcome: 'paid',
    attachCard: attachValidCard,
    eventType: 'invoice.payment_succeeded',
    last4: '4242',
  },
  {
    outcome: 'declined',
    attachCard: attachDecliningCard,
    eventType: 'invoice.payment_failed',
    last4: '0341', // the test card that attaches and then declines charges
  },
])('Final invoice after cancellation ($outcome)', ({ attachCard, eventType, last4 }) => {
  let userId: string;
  let cusId: string;
  let subId: string;

  beforeAll(async () => {
    userId = `test-fic-${crypto.randomUUID()}`;
    cusId = await createTestCustomer(userId);
    await seedBillingRecord(userId, cusId, 'active');
    const paymentMethodId = await attachCard(cusId);
    await pollForPaymentMethod({ userId, paymentMethodId });

    subId = await createSubscription({ userId, customerId: cusId, paymentMethodId });
    await pollUntil(
      async () => ((await getBillingRecord(userId))?.subscriptionId?.S === subId ? true : null),
      30_000,
    );
    await reportUsage(cusId);
  }, 120_000);

  afterAll(async () => {
    await getStripeClient().customers.del(cusId);
    await deleteBillingRecord(userId);
  });

  it('leaves the org in grace once the final invoice is settled', async () => {
    const invoiceId = await cancelAndSettleFinalInvoice(subId);
    await pollForBillingStatusChange({
      userId,
      expectedStatus: 'grace_period',
      fromStatus: 'active',
    });
    await waitForEventHandled(eventType, invoiceId);

    expect(await getBillingRecord(userId)).toStrictEqual({
      pk: { S: `ORG#${testOrgId(userId)}` },
      sk: { S: 'SUBSCRIPTION' },
      orgId: { S: testOrgId(userId) },
      userId: { S: userId },
      stripeCustomerId: { S: cusId },
      subscriptionId: { S: subId },
      subscriptionStatus: { S: 'grace_period' },
      currentPeriodStart: { S: expect.any(String) },
      currentPeriodEnd: { S: expect.any(String) },
      canceledAt: { S: expect.any(String) },
      gracePeriodEndsAt: { S: expect.any(String) },
      updatedAt: { S: expect.any(String) },
      paymentMethodBrand: { S: 'visa' },
      paymentMethodId: { S: expect.any(String) },
      paymentMethodLast4: { S: last4 },
      paymentMethodExpYear: { N: expect.any(String) },
      paymentMethodExpMonth: { N: expect.any(String) },
    });
  });
});
