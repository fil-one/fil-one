import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { Options as RetryOptions } from 'p-retry';
import { SubscriptionStatus } from '@filone/shared';
import { getDynamoClient } from './ddb-client.js';
import { syncTenantStatusInProvisionedRegions, type RegionSyncOutcome } from './region-helpers.js';

const dynamo = getDynamoClient();

/** orgId from the user's billing record, or null when the record/field is missing. */
export async function resolveOrgId(userId: string, tableName: string): Promise<string | null> {
  const billingResult = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
      ProjectionExpression: 'orgId',
    }),
  );
  const orgId = billingResult.Item?.orgId?.S;
  if (!orgId) {
    console.warn('[deleted-customer-cleanup] No orgId on billing record for user:', userId);
    return null;
  }
  return orgId;
}

/**
 * Closes out billing state for a Stripe customer that no longer exists:
 * disables the tenant in every provisioned region, then marks the billing
 * record canceled (no grace period).
 *
 * Invariant: if any region fails to sync, the billing record is left
 * untouched — a canceled record drops out of the usage-reporting scan and the
 * webhook's Stripe retries, so canceling early would strand the failed
 * region. Callers apply their own policy to the returned outcomes (webhook:
 * assertRegionSyncSucceeded → 500 → Stripe retries; usage worker: heal-failed
 * audit → retried on the next daily run).
 */
export async function closeOutDeletedCustomer(params: {
  tableName: string;
  userId: string;
  orgId: string | null;
  retry?: RetryOptions;
}): Promise<RegionSyncOutcome[]> {
  const { tableName, userId, orgId, retry } = params;

  const outcomes = orgId
    ? await syncTenantStatusInProvisionedRegions(orgId, 'disabled', retry)
    : [];
  if (outcomes.some((o) => o.outcome === 'error')) return outcomes;

  const now = new Date().toISOString();
  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: {
          pk: { S: `CUSTOMER#${userId}` },
          sk: { S: 'SUBSCRIPTION' },
        },
        UpdateExpression:
          'SET subscriptionStatus = :status, canceledAt = :now, updatedAt = :now REMOVE gracePeriodEndsAt',
        ExpressionAttributeValues: {
          ':status': { S: SubscriptionStatus.Canceled },
          ':now': { S: now },
        },
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // Customer without a billing record (created outside the app, or record
      // already removed) — nothing to cancel; do not fail the caller.
      console.warn('[deleted-customer-cleanup] No billing record to cancel', { userId });
      return outcomes;
    }
    throw err;
  }
  return outcomes;
}
