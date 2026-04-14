import {
  GetItemCommand,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { SubscriptionStatus } from '@filone/shared';
import { Resource } from 'sst';
import { updateTenantStatus } from '../lib/aurora-backoffice.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { setOrgAuroraTenantStatus } from '../lib/org-profile.js';
import { isOrgSetupComplete } from '../lib/org-setup-status.js';

const dynamo = getDynamoClient();

type Action = 'cancel' | 'write_lock';

interface Candidate {
  pk: string;
  userId: string;
  orgId: string;
  subscriptionStatus: string;
  action: Action;
}

// eslint-disable-next-line max-lines-per-function, complexity/complexity
export async function handler(): Promise<void> {
  const billingTableName = Resource.BillingTable.name;
  const now = new Date();
  const nowMs = now.getTime();

  console.log('[grace-period-enforcer] Starting enforcement run', {
    timestamp: now.toISOString(),
  });

  // Scan for grace_period records
  const candidates: Candidate[] = [];
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: billingTableName,
        FilterExpression: 'sk = :sk AND subscriptionStatus = :gracePeriod',
        ExpressionAttributeValues: {
          ':sk': { S: 'SUBSCRIPTION' },
          ':gracePeriod': { S: SubscriptionStatus.GracePeriod },
        },
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }),
    );

    for (const item of result.Items ?? []) {
      const record = unmarshall(item);

      if (!record.orgId) {
        console.warn('[grace-period-enforcer] Missing orgId, skipping', { pk: record.pk });
        continue;
      }

      const userId = (record.pk as string).replace('CUSTOMER#', '');
      const base = {
        pk: record.pk,
        userId,
        orgId: record.orgId,
        subscriptionStatus: record.subscriptionStatus,
      };

      const gracePeriodEndsAt = record.gracePeriodEndsAt as string | undefined;
      if (gracePeriodEndsAt && new Date(gracePeriodEndsAt).getTime() < nowMs) {
        // Grace period expired → cancel + DISABLE
        candidates.push({ ...base, action: 'cancel' });
      } else {
        // Grace period still active → ensure WRITE_LOCKED
        candidates.push({ ...base, action: 'write_lock' });
      }
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log('[grace-period-enforcer] Found candidates', { count: candidates.length });

  if (candidates.length === 0) return;

  let canceled = 0;
  let writeLocked = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidate of candidates) {
    try {
      // Resolve Aurora tenant for all actions
      const orgResult = await dynamo.send(
        new GetItemCommand({
          TableName: Resource.UserInfoTable.name,
          Key: {
            pk: { S: `ORG#${candidate.orgId}` },
            sk: { S: 'PROFILE' },
          },
          ProjectionExpression: 'auroraTenantId, setupStatus, auroraTenantStatus',
        }),
      );

      const auroraTenantId = orgResult.Item?.auroraTenantId?.S;
      const setupStatus = orgResult.Item?.setupStatus?.S;
      const currentAuroraStatus = orgResult.Item?.auroraTenantStatus?.S;
      const tenantReady = auroraTenantId && isOrgSetupComplete(setupStatus);

      if (!tenantReady) {
        skipped++;
        console.warn('[grace-period-enforcer] Tenant not ready, skipping', {
          userId: candidate.userId,
          orgId: candidate.orgId,
          auroraTenantId,
          setupStatus,
        });
        continue;
      }

      if (candidate.action === 'cancel') {
        await updateTenantStatus({ tenantId: auroraTenantId, status: 'DISABLED' });
        await setOrgAuroraTenantStatus(candidate.orgId, 'DISABLED');
        // Transition DynamoDB status to canceled
        await dynamo.send(
          new UpdateItemCommand({
            TableName: billingTableName,
            Key: { pk: { S: candidate.pk }, sk: { S: 'SUBSCRIPTION' } },
            UpdateExpression: 'SET subscriptionStatus = :status, updatedAt = :now',
            ExpressionAttributeValues: {
              ':status': { S: SubscriptionStatus.Canceled },
              ':now': { S: now.toISOString() },
            },
          }),
        );
        canceled++;

        console.log('[grace-period-enforcer] Canceled + disabled', {
          userId: candidate.userId,
          orgId: candidate.orgId,
          previousStatus: candidate.subscriptionStatus,
        });
      } else if (candidate.action === 'write_lock') {
        // Non-expired grace period — ensure Aurora is WRITE_LOCKED
        if (currentAuroraStatus === 'WRITE_LOCKED' || currentAuroraStatus === 'DISABLED') {
          skipped++;
          continue;
        }

        await updateTenantStatus({ tenantId: auroraTenantId, status: 'WRITE_LOCKED' });
        await setOrgAuroraTenantStatus(candidate.orgId, 'WRITE_LOCKED');
        writeLocked++;
        console.log('[grace-period-enforcer] WRITE_LOCKED (retry)', {
          userId: candidate.userId,
          orgId: candidate.orgId,
        });
      }
    } catch (error) {
      failed++;
      console.error('[grace-period-enforcer] Failed to process record', {
        userId: candidate.userId,
        orgId: candidate.orgId,
        action: candidate.action,
        error: (error as Error).message,
      });
    }
  }

  console.log('[grace-period-enforcer] Complete', {
    candidates: candidates.length,
    canceled,
    writeLocked,
    skipped,
    failed,
  });
}
