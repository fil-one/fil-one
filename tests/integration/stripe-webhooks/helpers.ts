// Re-export all shared helpers
export {
  getStripeClient,
  getDynamoClient,
  getBillingTableName,
  getUserInfoTableName,
  sleep,
  pollUntil,
  PollTimeoutError,
  seedBillingRecord,
  getBillingRecord,
  deleteBillingRecord,
  createTestCustomer,
} from '../helpers.js';

import { getStripeClient, pollUntil, PollTimeoutError, getBillingRecord } from '../helpers.js';
import { Resource } from 'sst';

// =============================================================================
// Stripe-webhook-specific helpers
// =============================================================================

export function getStripePriceId(): string {
  const priceId =
    process.env.STRIPE_PRICE_ID ??
    (Resource as unknown as Record<string, { value: string } | undefined>).StripePriceId?.value ??
    '';
  if (!priceId) {
    throw new Error('STRIPE_PRICE_ID is not set and not available from SST Resource');
  }
  return priceId;
}

export async function attachValidCard(customerId: string): Promise<string> {
  const pm = await getStripeClient().paymentMethods.attach('pm_card_visa', {
    customer: customerId,
  });
  await getStripeClient().customers.update(customerId, {
    invoice_settings: { default_payment_method: pm.id },
  });
  return pm.id;
}

export async function attachDecliningCard(customerId: string): Promise<string> {
  const pm = await getStripeClient().paymentMethods.attach('pm_card_chargeCustomerFail', {
    customer: customerId,
  });
  await getStripeClient().customers.update(customerId, {
    invoice_settings: { default_payment_method: pm.id },
  });
  return pm.id;
}

export async function createAndPayInvoice(customerId: string): Promise<string> {
  const stripeClient = getStripeClient();
  await stripeClient.invoiceItems.create({
    customer: customerId,
    amount: 500,
    currency: 'usd',
  });

  const invoice = await stripeClient.invoices.create({
    customer: customerId,
    pending_invoice_items_behavior: 'include',
  });

  await stripeClient.invoices.finalizeInvoice(invoice.id);
  await stripeClient.invoices.pay(invoice.id);

  return invoice.id;
}

export async function createAndFailInvoice(customerId: string): Promise<string> {
  const stripeClient = getStripeClient();
  await stripeClient.invoiceItems.create({
    customer: customerId,
    amount: 500,
    currency: 'usd',
  });

  const invoice = await stripeClient.invoices.create({
    customer: customerId,
    pending_invoice_items_behavior: 'include',
    auto_advance: false,
  });

  await stripeClient.invoices.finalizeInvoice(invoice.id);
  try {
    await getStripeClient().invoices.pay(invoice.id);
  } catch {
    console.debug('Expected invoice payment failure');
  }

  return invoice.id;
}

// =============================================================================
// Waiting
// =============================================================================

export async function pollForBillingStatusChange({
  userId,
  expectedStatus,
  fromStatus,
  timeoutMs = 30_000,
}: {
  userId: string;
  expectedStatus: string;
  fromStatus: string;
  timeoutMs?: number;
}): Promise<void> {
  await pollUntil(async () => {
    const record = await getBillingRecord(userId);
    if (!record) return null;
    const status = record.subscriptionStatus?.S;
    if (status === expectedStatus) return record;
    if (status === fromStatus) return null;
    throw new Error(
      `Unexpected subscriptionStatus "${status}" while polling for "${expectedStatus}" (from: "${fromStatus}")`,
    );
  }, timeoutMs);
}

export async function pollForPaymentMethod({
  userId,
  paymentMethodId,
  timeoutMs = 30_000,
}: {
  userId: string;
  paymentMethodId: string;
  timeoutMs?: number;
}): Promise<void> {
  await pollUntil(async () => {
    const record = await getBillingRecord(userId);
    if (!record) return null;
    const pmId = record.paymentMethodId?.S;
    if (pmId === paymentMethodId) return record;
    return null;
  }, timeoutMs);
}

export async function pollTestClockReady({
  clockId,
  timeoutSeconds = 270,
}: {
  clockId: string;
  timeoutSeconds?: number;
}): Promise<void> {
  let lastStatus: string | undefined;
  try {
    await pollUntil(
      async () => {
        const clockState = await getStripeClient().testHelpers.testClocks.retrieve(clockId);
        lastStatus = clockState.status;
        if (clockState.status === 'ready') return true;
        if (clockState.status === 'internal_failure') {
          throw new Error(`Test clock ${clockId} entered internal_failure state`);
        }
        return null;
      },
      timeoutSeconds * 1000,
      { initialDelay: 200 },
    );
  } catch (err) {
    if (err instanceof PollTimeoutError) {
      throw new Error(
        `pollTestClockReady timed out after ${timeoutSeconds}s ` +
          `(last status: ${lastStatus ?? 'unknown'}, clockId: ${clockId})`,
        { cause: err },
      );
    }
    throw err;
  }
}
