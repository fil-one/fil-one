import { Resource } from 'sst';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import type { Role } from './roles.ts';

// Resets BillingTable records for E2E test users to known states before each
// run. Trial periods can elapse and `past_due` subscriptions can advance to
// `canceled`, so we re-seed deterministic state instead of relying on
// long-lived test-user state in staging.
//
// Direct DynamoDB writes mirror the pattern used by integration tests
// (tests/integration/helpers.ts: seedBillingRecord). Source of truth for
// subscriptionStatus values is packages/shared/src/api/billing.ts.

const AWS_REGION = process.env.AWS_REGION ?? 'us-east-2';

function getBillingTableName(): string {
  return (Resource as unknown as Record<string, { name: string }>).BillingTable.name;
}

function isoFromNow(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
}

function isoDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

const DESIRED_STATE: Record<Role, { status: string; extra: Record<string, string> }> = {
  paid: {
    status: 'active',
    extra: {
      currentPeriodEnd: isoFromNow(30),
    },
  },
  unpaid: {
    status: 'past_due',
    extra: {
      currentPeriodEnd: isoFromNow(30),
      lastPaymentFailedAt: isoDaysAgo(1),
    },
  },
  trial: {
    status: 'trialing',
    extra: {
      trialEndsAt: isoFromNow(14),
    },
  },
};

let dynamoClient: DynamoDBClient | null = null;
function getDynamoClient(): DynamoDBClient {
  dynamoClient ??= new DynamoDBClient({ region: AWS_REGION });
  return dynamoClient;
}

export async function resetBillingState(role: Role, userId: string): Promise<void> {
  const { status, extra } = DESIRED_STATE[role];
  const item: Record<string, { S: string }> = {
    pk: { S: `CUSTOMER#${userId}` },
    sk: { S: 'SUBSCRIPTION' },
    stripeCustomerId: { S: `cus_e2e_${role}` },
    subscriptionStatus: { S: status },
    updatedAt: { S: new Date().toISOString() },
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { S: v }])),
  };

  await getDynamoClient().send(
    new PutItemCommand({ TableName: getBillingTableName(), Item: item }),
  );
}
