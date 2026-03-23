import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  createTestCustomer,
  attachValidCard,
  seedBillingRecord,
  sleep,
  getBillingRecord,
  deleteBillingRecord,
  getStripeClient,
} from './helpers.js';

describe('Payment Method Update (customer.updated)', () => {
  let userId: string;
  let cusId: string;
  let firstPmId: string;

  beforeAll(async () => {
    userId = `test-pmu-${crypto.randomUUID()}`;
    cusId = await createTestCustomer(userId);
    firstPmId = await attachValidCard(cusId);
    await seedBillingRecord(userId, cusId, 'active', {
      paymentMethodId: { S: firstPmId },
      paymentMethodLast4: { S: '4242' },
      paymentMethodBrand: { S: 'visa' },
    });
  });

  afterAll(async () => {
    await getStripeClient().customers.del(cusId);
    await deleteBillingRecord(userId);
  });

  it('should sync new payment method last4 after customer portal card update', async () => {
    const stripe = getStripeClient();

    // Attach a second card (Mastercard) and set as default
    const newPm = await stripe.paymentMethods.attach('pm_card_mastercard', {
      customer: cusId,
    });
    await stripe.customers.update(cusId, {
      invoice_settings: { default_payment_method: newPm.id },
    });

    // Wait for webhook delivery and processing
    await sleep(15 * 1000);

    const record = await getBillingRecord(userId);
    expect(record).toBeTruthy();
    expect(record!.paymentMethodId?.S).toBe(newPm.id);
    expect(record!.paymentMethodLast4?.S).toBe('4444');
    expect(record!.paymentMethodBrand?.S).toBe('mastercard');
  });
});
