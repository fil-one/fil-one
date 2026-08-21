import { Resource } from 'sst';
import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import type { Role } from './roles.util.ts';

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

function getOrgTableName(): string {
  return (Resource as unknown as Record<string, { name: string }>).OrgTable.name;
}

/**
 * The org the test user belongs to, from their membership rows.
 *
 * Resolved rather than configured: the alternative is a fourth secret per role
 * in the staging workflow, and the answer is already in the table. The user
 * belongs to exactly one org — these are single-purpose test accounts — so the
 * first inverse item is the answer.
 */
async function resolveOrgId(userId: string): Promise<string | undefined> {
  const result = await getDynamoClient().send(
    new QueryCommand({
      TableName: getOrgTableName(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: {
        ':pk': { S: `USER#${userId}` },
        ':sk': { S: 'MEMBERSHIP#' },
      },
      Limit: 1,
    }),
  );
  const sk = result.Items?.[0]?.sk?.S;
  return sk?.startsWith('MEMBERSHIP#') ? sk.slice('MEMBERSHIP#'.length) : undefined;
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
  await patchSubscription(role, userId, { subscriptionStatus: status, ...extra });
}

// Marks the subscription active regardless of the role's desired state, so
// write-gated operations succeed for roles the tests otherwise keep in a
// write-blocked state (`unpaid` is `past_due`, which the subscription guard
// rejects with 403 GRACE_PERIOD_WRITE_BLOCKED). Callers must restore the role's
// own state with `resetBillingState` afterwards. Reuses the `paid` state so the
// two definitions cannot drift apart.
export async function activateSubscription(role: Role, userId: string): Promise<void> {
  const { status, extra } = DESIRED_STATE.paid;
  await patchSubscription(role, userId, { subscriptionStatus: status, ...extra });
}

/**
 * Patch every key the row lives under.
 *
 * The application reads the org key and falls back to the user's, so patching
 * one of them leaves the run at the mercy of whether the backfill has reached
 * this test account: the suite would set up `past_due` on the legacy row and the
 * app would keep serving `active` off the org twin. Both are patched, and it is
 * an error for neither to exist.
 */
async function patchSubscription(
  role: Role,
  userId: string,
  attributes: Record<string, string>,
): Promise<void> {
  const fields: Record<string, string> = {
    ...attributes,
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

  const orgId = await resolveOrgId(userId);
  const keys = [...(orgId ? [`ORG#${orgId}`] : []), `CUSTOMER#${userId}`];

  let patched = 0;
  for (const pk of keys) {
    try {
      await getDynamoClient().send(
        new UpdateItemCommand({
          TableName: getBillingTableName(),
          Key: { pk: { S: pk }, sk: { S: 'SUBSCRIPTION' } },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ConditionExpression: 'attribute_exists(pk)',
        }),
      );
      patched += 1;
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    }
  }

  if (patched === 0) {
    throw new Error(
      `E2E test user ${userId} (role=${role}, org=${orgId ?? 'unresolved'}) has no BillingTable ` +
        `record on either key. Pre-seed it (orgId, stripeCustomerId, subscriptionId) before running E2E tests.`,
    );
  }
}
