import {
  ConditionalCheckFailedException,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { Options as RetryOptions } from 'p-retry';
import { SubscriptionStatus } from '@filone/shared';
import { Resource } from 'sst';
import { DELETION_FENCE } from './billing-fence.js';
import { getDynamoClient } from './ddb-client.js';
import { syncTenantStatusInProvisionedRegions, type RegionSyncOutcome } from './region-helpers.js';

const dynamo = getDynamoClient();

/**
 * Maps a user to their org via the billing SUBSCRIPTION record (BillingTable
 * pk CUSTOMER#<userId>) — not the UserInfo-table user→org mapping used by API
 * auth. Returns null when the record or its orgId field is missing.
 */
export async function resolveOrgIdFromSubscription(userId: string): Promise<string | null> {
  const billingResult = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.BillingTable.name,
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
 *
 * `billingCanceled` is false when the record was absent or the FIL-112
 * deletion fence rejected the write (org mid-teardown) — callers must not
 * treat the customer as dunning-canceled in that case.
 */
export async function closeOutDeletedCustomer(params: {
  userId: string;
  orgId: string | null;
  retry?: RetryOptions;
}): Promise<{ outcomes: RegionSyncOutcome[]; billingCanceled: boolean }> {
  const { userId, orgId, retry } = params;

  // No orgId means the billing record is missing or predates the orgId field
  // (customer created outside the app, or record already removed) — there is
  // no tenant to look up, so only the record cancelation below applies.
  if (!orgId) {
    console.warn('[deleted-customer-cleanup] No orgId — skipping tenant status sync', { userId });
  }
  const outcomes = orgId
    ? await syncTenantStatusInProvisionedRegions(orgId, 'disabled', retry)
    : [];
  if (outcomes.some((o) => o.outcome === 'error')) return { outcomes, billingCanceled: false };

  const now = new Date().toISOString();
  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: Resource.BillingTable.name,
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
        // FIL-112 deletion fence: while an account teardown is in flight, our
        // own subscriptions.cancel echoes back as webhook events — this write
        // must not touch a record the teardown owns (or upsert it back after
        // the purge).
        ConditionExpression: DELETION_FENCE,
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // Customer without a billing record (created outside the app, record
      // already removed, or org mid-deletion) — nothing to cancel; do not
      // fail the caller.
      console.warn('[deleted-customer-cleanup] No billing record to cancel or org mid-deletion', {
        userId,
      });
      return { outcomes, billingCanceled: false };
    }
    throw err;
  }
  return { outcomes, billingCanceled: true };
}
