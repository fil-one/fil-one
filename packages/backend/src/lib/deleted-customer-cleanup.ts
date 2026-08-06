import {
  ConditionalCheckFailedException,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { Options as RetryOptions } from 'p-retry';
import { SubscriptionStatus } from '@filone/shared';
import { Resource } from 'sst';
import { DELETION_GUARD } from './deletion-guard.js';
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
 * Cross-checks a billing-derived orgId against the authoritative USER#/PROFILE
 * mapping, which is written from the authenticated session at onboarding and
 * never from Stripe metadata. The billing orgId is backfilled from that
 * metadata with if_not_exists, so a value once learned from wrong or stale
 * metadata is never corrected — and an irreversible teardown must not run on
 * it. A missing profile or a mismatch is a data-integrity fault, so it is
 * logged at error level and the caller must refuse.
 */
export async function verifyOrgMatchesUserProfile(
  userId: string,
  billingOrgId: string,
): Promise<boolean> {
  const profileResult = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: {
        pk: { S: `USER#${userId}` },
        sk: { S: 'PROFILE' },
      },
      ProjectionExpression: 'orgId',
      ConsistentRead: true,
    }),
  );
  const profileOrgId = profileResult.Item?.orgId?.S ?? null;
  if (profileOrgId !== billingOrgId) {
    console.error(
      '[deleted-customer-cleanup] Billing orgId does not match the USER#/PROFILE orgId — refusing teardown',
      { userId, billingOrgId, profileOrgId },
    );
    return false;
  }
  return true;
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
 * `billingCanceled` is false when the record was absent or the deletion guard
 * rejected the write — callers must not report a dunning cancellation then.
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
        // A teardown's own subscriptions.cancel echoes back here as a webhook;
        // this write must not touch (or re-upsert) a record it owns.
        ConditionExpression: DELETION_GUARD,
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // Customer without a billing record (created outside the app, record
      // already removed, or org mid-deletion) — nothing to cancel.
      console.warn('[deleted-customer-cleanup] No billing record to cancel or org mid-deletion', {
        userId,
      });
      return { outcomes, billingCanceled: false };
    }
    throw err;
  }
  return { outcomes, billingCanceled: true };
}
