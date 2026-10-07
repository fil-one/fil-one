import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';
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
  testOrgId,
  getDynamoClient,
  getBillingTableName,
  pollUntil,
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
      pk: { S: `ORG#${testOrgId(userId)}` },
      sk: { S: 'SUBSCRIPTION' },
      orgId: { S: testOrgId(userId) },
      userId: { S: userId },
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

  it('marks the event processed once the worker has handled it', async () => {
    const invoiceId = await createAndFailInvoice(cusId);

    // The worker writes the mark after the billing update. Without it, Stripe's
    // later redeliveries of the event would be processed again.
    const eventId = await pollUntil(async () => {
      const { data } = await getStripeClient().events.list({
        type: 'invoice.payment_failed',
        limit: 20,
      });
      const event = data.find((e) => (e.data.object as { id?: string }).id === invoiceId);
      return event?.id ?? null;
    }, 30_000);

    const mark = await pollUntil(async () => {
      const { Item } = await getDynamoClient().send(
        new GetItemCommand({
          TableName: getBillingTableName(),
          Key: { pk: { S: `WEBHOOK#${eventId}` }, sk: { S: 'EVENT' } },
        }),
      );
      return Item ?? null;
    }, 30_000);

    expect(mark.eventType).toEqual({ S: 'invoice.payment_failed' });
  });
});
