import { Resource } from 'sst';
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  DeleteItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import Stripe from 'stripe';

// =============================================================================
// Config (reads from SST Resource, available via `sst shell`)
// =============================================================================

const AWS_REGION = process.env.AWS_REGION ?? 'us-east-1';

export function getStripeClient(): Stripe {
  return new Stripe(
    (Resource as unknown as Record<string, { value: string }>).StripeSecretKey.value,
  );
}

export function getDynamoClient(): DynamoDBClient {
  return new DynamoDBClient({ region: AWS_REGION });
}

export function getBillingTableName(): string {
  return (Resource as unknown as Record<string, { name: string }>).BillingTable.name;
}

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

// =============================================================================
// Utilities
// =============================================================================
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// DynamoDB helpers
// =============================================================================

export async function seedBillingRecord(
  userId: string,
  customerId: string,
  status: string,
  extra?: Record<string, { S: string }>,
): Promise<void> {
  const item: Record<string, { S: string }> = {
    pk: { S: `CUSTOMER#${userId}` },
    sk: { S: 'SUBSCRIPTION' },
    orgId: { S: 'test-org' },
    stripeCustomerId: { S: customerId },
    subscriptionStatus: { S: status },
    updatedAt: { S: new Date().toISOString() },
    ...extra,
  };

  await getDynamoClient().send(
    new PutItemCommand({
      TableName: getBillingTableName(),
      Item: item,
    }),
  );
}

export async function getBillingRecord(
  userId: string,
): Promise<Record<string, AttributeValue> | null> {
  const result = await getDynamoClient().send(
    new GetItemCommand({
      TableName: getBillingTableName(),
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
    }),
  );
  return result.Item ?? null;
}

export async function deleteBillingRecord(userId: string): Promise<void> {
  try {
    await getDynamoClient().send(
      new DeleteItemCommand({
        TableName: getBillingTableName(),
        Key: {
          pk: { S: `CUSTOMER#${userId}` },
          sk: { S: 'SUBSCRIPTION' },
        },
      }),
    );
  } catch (error) {
    console.error('Failed to delete billing record:', error);
  }
}

// =============================================================================
// Stripe helpers
// =============================================================================

export async function createTestCustomer(userId: string, testClock?: string): Promise<string> {
  const params: Stripe.CustomerCreateParams = {
    metadata: { userId, orgId: 'test-org' },
    description: `Webhook test customer (${userId})`,
  };
  if (testClock) {
    params.test_clock = testClock;
  }
  const customer = await getStripeClient().customers.create(params);
  return customer.id;
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

export async function attachDecliningCard(customerId: string): Promise<void> {
  const pm = await getStripeClient().paymentMethods.attach('pm_card_chargeCustomerFail', {
    customer: customerId,
  });
  await getStripeClient().customers.update(customerId, {
    invoice_settings: { default_payment_method: pm.id },
  });
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
export async function pollTestClockReady(clockId: string, timeoutSeconds = 120): Promise<void> {
  const timeoutMs = timeoutSeconds * 1000;
  let elapsed = 0;
  let delay = 200;
  const maxDelay = 2000;

  while (elapsed < timeoutMs) {
    const clockState = await getStripeClient().testHelpers.testClocks.retrieve(clockId);
    if (clockState.status === 'ready') {
      return;
    }
    await sleep(delay);
    elapsed += delay;
    delay = Math.min(delay * 2, maxDelay);
  }
  throw new Error(`Test clock ${clockId} did not reach 'ready' status after ${timeoutSeconds}s`);
}
