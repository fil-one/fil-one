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

export function getUserInfoTableName(): string {
  return (Resource as unknown as Record<string, { name: string }>).UserInfoTable.name;
}

// =============================================================================
// Utilities
// =============================================================================

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollUntil<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number,
  opts?: { initialDelay?: number; maxDelay?: number },
): Promise<T> {
  const { initialDelay = 500, maxDelay = 2000 } = opts ?? {};
  let elapsed = 0;
  let delay = initialDelay;

  while (elapsed < timeoutMs) {
    const result = await fn();
    if (result !== null) return result;
    await sleep(delay);
    elapsed += delay;
    delay = Math.min(delay * 2, maxDelay);
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
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
