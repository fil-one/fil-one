import { ScanCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { SubscriptionStatus } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import {
  getProvisionedRegions,
  setTenantStatusInProvisionedRegions,
  type ProvisionedRegion,
} from '../lib/region-helpers.js';

const dynamo = getDynamoClient();

type Action = 'cancel' | 'write_lock';

interface Candidate {
  pk: string;
  userId: string;
  orgId: string;
  subscriptionStatus: string;
  action: Action;
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
  if (candidate.action === 'cancel') {
    await cancelSubscriptionAndDisableTenant(candidate, billingTableName, now);
    return 'canceled';
  }

  return ensureTenantWriteLocked(candidate);
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

// Grace period expired — disable the tenant on every orchestrator it exists on
// and cancel the subscription. The disable is best-effort per orchestrator
// (orchestrators with no tenant are skipped); the billing record is canceled
// unconditionally so a stuck/unprovisioned org still transitions out of grace.
async function cancelSubscriptionAndDisableTenant(
  candidate: Candidate,
  billingTableName: string,
  now: Date,
): Promise<void> {
  await setTenantStatusInProvisionedRegions(candidate.orgId, 'disabled');
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

// Non-expired grace period — ensure every orchestrator tenant is write-locked.
// Probe each orchestrator's live status (its own source of truth) so we skip a
// redundant lock call and, critically, never downgrade a tenant that is already
// `disabled` back to `write-locked`.
async function ensureTenantWriteLocked(candidate: Candidate): Promise<CandidateOutcome> {
  const ready = await getProvisionedRegions(candidate.orgId);

  if (ready.length === 0) {
    console.warn('[grace-period-enforcer] No ready tenant on any orchestrator, skipping', {
      userId: candidate.userId,
      orgId: candidate.orgId,
    });
    return 'skipped';
  }

  const outcomes = await Promise.all(ready.map((entry) => writeLockTenant(candidate, entry)));
  return outcomes.includes('write_locked') ? 'write_locked' : 'skipped';
}

async function writeLockTenant(
  candidate: Candidate,
  { orchestrator, tenantId }: ProvisionedRegion,
): Promise<CandidateOutcome> {
  const probe = await orchestrator.getTenantStatus(tenantId);

  // Can't read live status → do NOT risk re-locking a tenant that may already
  // be disabled. Surface as a failure so it retries on the next run.
  if (probe.kind === 'error') {
    throw new Error(`${orchestrator.id} status probe failed for tenant ${tenantId}`, {
      cause: probe.cause,
    });
  }

  if (probe.kind === 'not_found') {
    console.warn('[grace-period-enforcer] tenant not found, skipping', {
      userId: candidate.userId,
      orgId: candidate.orgId,
      orchestrator: orchestrator.id,
      tenantId,
    });
    return 'skipped';
  }

  if (probe.status === 'write-locked' || probe.status === 'disabled') {
    return 'skipped';
  }

  await orchestrator.updateTenantStatus(tenantId, 'write-locked');
  console.log('[grace-period-enforcer] WRITE_LOCKED (retry)', {
    userId: candidate.userId,
    orgId: candidate.orgId,
    orchestrator: orchestrator.id,
    tenantId,
  });
  return 'write_locked';
}
