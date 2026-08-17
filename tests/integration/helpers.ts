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
 * Both keys the row lives under, org first — the order the application reads
 * them in. A suite that seeds its own `orgId` names it here too, so the key and
 * the attribute can never disagree.
 */
const subscriptionKeys = (userId: string, orgId: string = testOrgId(userId)) => [
  { pk: { S: `ORG#${orgId}` }, sk: { S: 'SUBSCRIPTION' } },
  { pk: { S: `CUSTOMER#${userId}` }, sk: { S: 'SUBSCRIPTION' } },
];

/**
 * Seed the subscription on both keys, the way the application writes it.
 *
 * Seeding one key only would test the wrong thing in both directions: seed just
 * the legacy row and a handler that correctly writes the org twin looks like it
 * wrote nothing; seed just the org row and the fallback path is never exercised.
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

  for (const key of subscriptionKeys(userId, orgId)) {
    await getDynamoClient().send(
      new PutItemCommand({
        TableName: getBillingTableName(),
        Item: { ...attributes, pk: key.pk },
      }),
    );
  }
}

/** The row the application would read: the org key first, the legacy key second. */
export async function getBillingRecord(
  userId: string,
  orgId?: string,
): Promise<Record<string, AttributeValue> | null> {
  for (const Key of subscriptionKeys(userId, orgId)) {
    const result = await getDynamoClient().send(
      new GetItemCommand({ TableName: getBillingTableName(), Key }),
    );
    if (result.Item) return result.Item;
  }
  return null;
}

export async function deleteBillingRecord(userId: string, orgId?: string): Promise<void> {
  for (const Key of subscriptionKeys(userId, orgId)) {
    try {
      await getDynamoClient().send(
        new DeleteItemCommand({ TableName: getBillingTableName(), Key }),
      );
    } catch (error) {
      console.error('Failed to delete billing record:', error);
    }
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
