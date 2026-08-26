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

export class PollTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`pollUntil timed out after ${timeoutMs}ms`);
    this.name = 'PollTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export async function pollUntil<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number,
  opts?: { initialDelay?: number; maxDelay?: number },
): Promise<T> {
  const { initialDelay = 500, maxDelay = 2000 } = opts ?? {};
  const deadline = Date.now() + timeoutMs;
  let delay = initialDelay;

  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== null) return result;
    await sleep(delay);
    delay = Math.min(delay * 2, maxDelay);
  }
  throw new PollTimeoutError(timeoutMs);
}

// =============================================================================
// DynamoDB helpers
// =============================================================================

/**
 * The org a test user's subscription belongs to.
 *
 * Derived from the user id, which every suite already makes unique per run, so
 * each test owns its own org row. The fixed `test-org` this replaced put every
 * webhook suite on one org, and the jobs now keep one row per org — so under
 * `fileParallelism` two suites' rows would collide and one of them would be
 * dropped by whichever ran second.
 */
export function testOrgId(userId: string): string {
  return `test-org-${userId}`;
}

/**
 * The key the row lives under. A suite that seeds its own `orgId` names it here
 * too, so the key and the attribute can never disagree.
 */
const subscriptionKey = (userId: string, orgId: string = testOrgId(userId)) => ({
  pk: { S: `ORG#${orgId}` },
  sk: { S: 'SUBSCRIPTION' },
});

/**
 * Seed the subscription on the key the application reads and writes.
 *
 * A `CUSTOMER#` row would be seeding a key nothing looks at: the handlers read
 * the org row and the scan-driven jobs skip anything else, so a suite seeded
 * there would watch every assertion fail for the wrong reason.
 */
export async function seedBillingRecord(
  userId: string,
  customerId: string,
  status: string,
  extra?: Record<string, { S: string }>,
): Promise<void> {
  const orgId = extra?.orgId?.S ?? testOrgId(userId);
  const attributes: Record<string, { S: string }> = {
    sk: { S: 'SUBSCRIPTION' },
    userId: { S: userId },
    stripeCustomerId: { S: customerId },
    subscriptionStatus: { S: status },
    updatedAt: { S: new Date().toISOString() },
    ...extra,
    orgId: { S: orgId },
  };

  await getDynamoClient().send(
    new PutItemCommand({
      TableName: getBillingTableName(),
      Item: { ...attributes, ...subscriptionKey(userId, orgId) },
    }),
  );
}

/** The row the application would read. */
export async function getBillingRecord(
  userId: string,
  orgId?: string,
): Promise<Record<string, AttributeValue> | null> {
  const result = await getDynamoClient().send(
    new GetItemCommand({
      TableName: getBillingTableName(),
      Key: subscriptionKey(userId, orgId),
    }),
  );
  return result.Item ?? null;
}

export async function deleteBillingRecord(userId: string, orgId?: string): Promise<void> {
  try {
    await getDynamoClient().send(
      new DeleteItemCommand({
        TableName: getBillingTableName(),
        Key: subscriptionKey(userId, orgId),
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
    metadata: { userId, orgId: testOrgId(userId) },
    description: `Webhook test customer (${userId})`,
  };
  if (testClock) {
    params.test_clock = testClock;
  }
  const customer = await getStripeClient().customers.create(params);
  return customer.id;
}
