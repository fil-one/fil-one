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

interface TenantRecord {
  auroraTenantId: string | undefined;
  setupStatus: string | undefined;
  currentAuroraStatus: string | undefined;
}

type CandidateOutcome = 'canceled' | 'write_locked' | 'skipped';

export async function handler(): Promise<void> {
  const billingTableName = Resource.BillingTable.name;
  const now = new Date();

  console.log('[grace-period-enforcer] Starting enforcement run', {
    timestamp: now.toISOString(),
  });

  const candidates = await scanGracePeriodCandidates(billingTableName, now.getTime());

  console.log('[grace-period-enforcer] Found candidates', { count: candidates.length });

  if (candidates.length === 0) return;

  let canceled = 0;
  let writeLocked = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidate of candidates) {
    try {
      const outcome = await processCandidate(candidate, billingTableName, now);
      if (outcome === 'canceled') canceled++;
      else if (outcome === 'write_locked') writeLocked++;
      else skipped++;
    } catch (error) {
      failed++;
      console.error('[grace-period-enforcer] Failed to process record', {
        userId: candidate.userId,
        orgId: candidate.orgId,
        action: candidate.action,
        error,
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

async function processCandidate(
  candidate: Candidate,
  billingTableName: string,
  now: Date,
): Promise<CandidateOutcome> {
  // Resolve Aurora tenant for all actions
  const tenant = await resolveTenantForEnforcement(candidate.orgId);
  const tenantReady = tenant.auroraTenantId && isOrgSetupComplete(tenant.setupStatus);

  if (!tenantReady) {
    console.warn('[grace-period-enforcer] Tenant not ready, skipping', {
      userId: candidate.userId,
      orgId: candidate.orgId,
      auroraTenantId: tenant.auroraTenantId,
      setupStatus: tenant.setupStatus,
    });
    return 'skipped';
  }

  const auroraTenantId = tenant.auroraTenantId!;

  if (candidate.action === 'cancel') {
    await cancelSubscriptionAndDisableTenant(candidate, auroraTenantId, billingTableName, now);
    return 'canceled';
  }

  return ensureTenantWriteLocked(candidate, auroraTenantId, tenant.currentAuroraStatus);
}

// Scan for grace_period records
async function scanGracePeriodCandidates(
  billingTableName: string,
  nowMs: number,
): Promise<Candidate[]> {
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

  return candidates;
}

async function resolveTenantForEnforcement(orgId: string): Promise<TenantRecord> {
  const orgResult = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: {
        pk: { S: `ORG#${orgId}` },
        sk: { S: 'PROFILE' },
      },
      ProjectionExpression: 'auroraTenantId, setupStatus, auroraTenantStatus',
    }),
  );

  return {
    auroraTenantId: orgResult.Item?.auroraTenantId?.S,
    setupStatus: orgResult.Item?.setupStatus?.S,
    currentAuroraStatus: orgResult.Item?.auroraTenantStatus?.S,
  };
}

async function cancelSubscriptionAndDisableTenant(
  candidate: Candidate,
  auroraTenantId: string,
  billingTableName: string,
  now: Date,
): Promise<void> {
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

  console.log('[grace-period-enforcer] Canceled + disabled', {
    userId: candidate.userId,
    orgId: candidate.orgId,
    previousStatus: candidate.subscriptionStatus,
  });
}

// Non-expired grace period — ensure Aurora is WRITE_LOCKED
async function ensureTenantWriteLocked(
  candidate: Candidate,
  auroraTenantId: string,
  currentAuroraStatus: string | undefined,
): Promise<CandidateOutcome> {
  if (currentAuroraStatus === 'WRITE_LOCKED' || currentAuroraStatus === 'DISABLED') {
    return 'skipped';
  }

  await updateTenantStatus({ tenantId: auroraTenantId, status: 'WRITE_LOCKED' });
  await setOrgAuroraTenantStatus(candidate.orgId, 'WRITE_LOCKED');
  console.log('[grace-period-enforcer] WRITE_LOCKED (retry)', {
    userId: candidate.userId,
    orgId: candidate.orgId,
  });
  return 'write_locked';
}
