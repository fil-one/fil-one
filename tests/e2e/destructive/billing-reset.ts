import { Resource } from 'sst';
import {
  DynamoDBClient,
  UpdateItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import type { Role } from './roles.ts';

// Patches BillingTable records for E2E test users back to known role-specific
// state before each run. Trial periods can elapse and `past_due` subscriptions
// can advance to `canceled`, so we re-seed deterministic state instead of
// relying on long-lived test-user state in staging.
//
// We use UpdateItemCommand (SET expression) rather than PutItemCommand so we
// only touch the test-state attributes (subscriptionStatus, currentPeriodEnd,
// trialEndsAt, lastPaymentFailedAt, updatedAt). Invariant fields the test user
// was pre-seeded with — orgId, stripeCustomerId (real `cus_…`), subscriptionId,
// trialStartedAt, currentPeriodStart — are preserved untouched. Background jobs
// (grace-period-enforcer, usage-reporting-orchestrator, stripe-webhook) skip
// records missing orgId, so clobbering it would break unrelated staging
// behavior. Source of truth for subscriptionStatus values is
// packages/shared/src/api/billing.ts.

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
  const fields: Record<string, string> = {
    subscriptionStatus: status,
    ...extra,
    updatedAt: new Date().toISOString(),
  };

  const names: Record<string, string> = {};
  const values: Record<string, { S: string }> = {};
  const sets: string[] = [];
  Object.entries(fields).forEach(([k, v], i) => {
    names[`#k${i}`] = k;
    values[`:v${i}`] = { S: v };
    sets.push(`#k${i} = :v${i}`);
  });

  try {
    await getDynamoClient().send(
      new UpdateItemCommand({
        TableName: getBillingTableName(),
        Key: {
          pk: { S: `CUSTOMER#${userId}` },
          sk: { S: 'SUBSCRIPTION' },
        },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new Error(
        `E2E test user ${userId} (role=${role}) has no BillingTable record. ` +
          `Pre-seed it (orgId, stripeCustomerId, subscriptionId) before running E2E tests.`,
      );
    }
    throw err;
  }
}
