import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  createTestCustomer,
  attachValidCard,
  seedBillingRecord,
  getBillingRecord,
  deleteBillingRecord,
  getStripeClient,
  pollForPaymentMethod,
} from './helpers.js';

describe('Payment Method Update (customer.updated)', () => {
  let userId: string;
  let cusId: string;

  beforeAll(async () => {
    userId = `test-pmu-${crypto.randomUUID()}`;
    cusId = await createTestCustomer(userId);
    await seedBillingRecord(userId, cusId, 'active');
    const firstPmId = await attachValidCard(cusId);
    await pollForPaymentMethod({ userId, paymentMethodId: firstPmId });
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

    // Wait for customer.updated webhook to process the new payment method
    await pollForPaymentMethod({ userId, paymentMethodId: newPm.id });

    const record = await getBillingRecord(userId);
    expect(record).toBeTruthy();
    expect(record!.paymentMethodId?.S).toBe(newPm.id);
    expect(record!.paymentMethodLast4?.S).toBe('4444');
    expect(record!.paymentMethodBrand?.S).toBe('mastercard');
  });
});
