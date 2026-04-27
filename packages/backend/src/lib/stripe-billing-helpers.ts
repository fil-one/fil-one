import {
  type AttributeValue,
  GetItemCommand,
  ScanCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { SubscriptionStatus } from '@filone/shared';
import { Resource } from 'sst';
import { updateTenantStatus } from '../lib/aurora-backoffice.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { setOrgAuroraTenantStatus } from '../lib/org-profile.js';
import { isOrgSetupComplete } from '../lib/org-setup-status.js';
import { bucketAttempt, emitDunningEscalation } from '../lib/stripe-dunning.js';

const dynamo = getDynamoClient();

export async function resolveAuroraTenantId(
  userId: string,
  tableName: string,
): Promise<{ orgId: string; auroraTenantId: string } | null> {
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
    console.warn('[stripe-webhook] No orgId on billing record for user:', userId);
    return null;
  }

  const orgResult = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: {
        pk: { S: `ORG#${orgId}` },
        sk: { S: 'PROFILE' },
      },
      ProjectionExpression: 'auroraTenantId, setupStatus',
    }),
  );
  const auroraTenantId = orgResult.Item?.auroraTenantId?.S;
  const setupStatus = orgResult.Item?.setupStatus?.S;
  if (!auroraTenantId || !isOrgSetupComplete(setupStatus)) {
    console.warn('[stripe-webhook] Aurora tenant not ready for org:', orgId);
    return null;
  }

  return { orgId, auroraTenantId };
}

export async function applyCancellationGracePeriod(args: {
  tableName: string;
  userId: string;
  graceDays: number;
  cancellationReason: string;
  attemptCount: number | null | undefined;
}): Promise<void> {
  const { tableName, userId, graceDays, cancellationReason, attemptCount } = args;

  const now = new Date();
  const gracePeriodEndsAt = new Date(now.getTime() + graceDays * 24 * 60 * 60 * 1000).toISOString();

  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: {
          pk: { S: `CUSTOMER#${userId}` },
          sk: { S: 'SUBSCRIPTION' },
        },
        UpdateExpression:
          'SET subscriptionStatus = :status, canceledAt = :now, gracePeriodEndsAt = :grace, updatedAt = :now',
        // Guard against creating a phantom partial row if the billing record
        // is gone (e.g. already canceled and pruned).
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: {
          ':status': { S: SubscriptionStatus.GracePeriod },
          ':now': { S: now.toISOString() },
          ':grace': { S: gracePeriodEndsAt },
        },
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      console.warn('[stripe-webhook] No billing row to update for cancellation', {
        userId,
        cancellationReason,
      });
      return;
    }
    throw err;
  }

  emitDunningEscalation({
    stage: 'canceled',
    reason: cancellationReason,
    attemptBucket: bucketAttempt(attemptCount),
  });

  // Best-effort: set Aurora tenant to WRITE_LOCKED during grace period.
  // If this fails, the daily grace-period-enforcer cron will also attempt
  // WRITE_LOCK for active grace periods missing it.
  try {
    const resolved = await resolveAuroraTenantId(userId, tableName);
    if (resolved) {
      await updateTenantStatus({ tenantId: resolved.auroraTenantId, status: 'WRITE_LOCKED' });
      await setOrgAuroraTenantStatus(resolved.orgId, 'WRITE_LOCKED');
      console.log('[stripe-webhook] Aurora tenant WRITE_LOCKED', {
        userId,
        orgId: resolved.orgId,
        auroraTenantId: resolved.auroraTenantId,
      });
    }
  } catch (error) {
    console.error('[stripe-webhook] Failed to WRITE_LOCK Aurora tenant', { userId, error });
  }
}

// Reverse lookup for customer.deleted events whose payload lacks metadata.userId.
// BillingTable has no GSI on stripeCustomerId; deletions are rare so a Scan is
// acceptable. Revisit if deletion volume grows or this becomes a Lambda timeout risk.
export async function resolveUserIdByStripeCustomer(
  tableName: string,
  stripeCustomerId: string,
): Promise<string | undefined> {
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;
  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'sk = :sk AND stripeCustomerId = :sid',
        ExpressionAttributeValues: {
          ':sk': { S: 'SUBSCRIPTION' },
          ':sid': { S: stripeCustomerId },
        },
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }),
    );

    const match = result.Items?.[0];
    if (match?.pk?.S) {
      return match.pk.S.replace('CUSTOMER#', '');
    }
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return undefined;
}
