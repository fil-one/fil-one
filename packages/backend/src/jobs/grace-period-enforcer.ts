import { ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { SubscriptionStatus } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { isOrgDeletedOrDeleting } from '../lib/org-profile.js';
import {
  assertRegionSyncSucceeded,
  syncTenantStatusInProvisionedRegions,
} from '../lib/region-helpers.js';
import {
  preferOrgRows,
  scannedSubscription,
  updateSubscriptionByUser,
} from '../lib/subscription-store.js';

const dynamo = getDynamoClient();

type Action = 'cancel' | 'write_lock';

interface Candidate {
  pk: string;
  userId?: string;
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
      // Cancelling and disabling is teardown's job now, and would race it.
      if (await isOrgDeletedOrDeleting(candidate.orgId)) {
        skipped++;
        continue;
      }

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
        FilterExpression:
          'sk = :sk AND subscriptionStatus = :gracePeriod AND attribute_not_exists(deletedAt)',
        ExpressionAttributeValues: {
          ':sk': { S: 'SUBSCRIPTION' },
          ':gracePeriod': { S: SubscriptionStatus.GracePeriod },
        },
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }),
    );

    for (const item of result.Items ?? []) {
      const record = unmarshall(item);
      const owner = scannedSubscription(record);

      if (!owner) {
        console.warn('[grace-period-enforcer] Missing orgId, skipping', { pk: record.pk });
        continue;
      }

      const base = { ...owner, subscriptionStatus: record.subscriptionStatus as string };

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

  return dedupeByOrgId(preferOrgRows(candidates));
}

/**
 * One candidate per org.
 *
 * This job had no dedupe, because until now one org could only be reached
 * through one row. Dual-writing means most orgs are two rows for the length of
 * the transition, and re-subscription history left some orgs with two legacy
 * rows before that — either way, processing both disables the same tenant twice
 * and counts one org as two. `preferOrgRows` has already dropped the twins, so
 * what reaches here is the second case, and it is logged loudly rather than
 * dropped quietly: two live subscriptions for one org is the collision the
 * backfill halts on and a human resolves.
 */
function dedupeByOrgId(candidates: readonly Candidate[]): Candidate[] {
  const byOrg = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const first = byOrg.get(candidate.orgId);
    if (!first) {
      byOrg.set(candidate.orgId, candidate);
      continue;
    }
    console.warn('[grace-period-enforcer] Second subscription row for one org, skipped', {
      orgId: candidate.orgId,
      processing: first.pk,
      skipped: candidate.pk,
    });
  }
  return [...byOrg.values()];
}

// Grace period expired — disable the tenant on every orchestrator it exists on
// and cancel the subscription. The disable is a probe-first sync: regions that
// are already disabled are skipped, so a partially disabled tenant converges
// on retry. A failed region throws before the cancel write, keeping the record
// in grace_period so the next run retries only the out-of-sync regions. An org
// with no provisioned regions still transitions out of grace (empty outcomes,
// cancel proceeds).
async function cancelSubscriptionAndDisableTenant(
  candidate: Candidate,
  billingTableName: string,
  now: Date,
): Promise<void> {
  assertRegionSyncSucceeded(
    await syncTenantStatusInProvisionedRegions(candidate.orgId, 'disabled'),
  );
  // Transition DynamoDB status to canceled, on both keys — a cancel that
  // reached only the row this scan happened to pick would leave the twin in
  // grace_period, and the next run would see the org again.
  await updateSubscriptionByUser(candidate, {
    UpdateExpression: 'SET subscriptionStatus = :status, updatedAt = :now',
    ExpressionAttributeValues: {
      ':status': { S: SubscriptionStatus.Canceled },
      ':now': { S: now.toISOString() },
    },
  });

  console.log('[grace-period-enforcer] Canceled + disabled', {
    userId: candidate.userId,
    orgId: candidate.orgId,
    previousStatus: candidate.subscriptionStatus,
  });
}

// Non-expired grace period — ensure every orchestrator tenant is write-locked.
// The sync helper probes each orchestrator's live status first, so redundant
// lock calls are skipped and a tenant that is already `disabled` is never
// downgraded back to `write-locked`.
async function ensureTenantWriteLocked(candidate: Candidate): Promise<CandidateOutcome> {
  const outcomes = await syncTenantStatusInProvisionedRegions(candidate.orgId, 'write-locked');

  if (outcomes.length === 0) {
    console.warn('[grace-period-enforcer] No ready tenant on any orchestrator, skipping', {
      userId: candidate.userId,
      orgId: candidate.orgId,
    });
    return 'skipped';
  }

  const updated = outcomes.filter((o) => o.outcome === 'updated');
  for (const o of updated) {
    console.log('[grace-period-enforcer] Tenant write-locked', {
      userId: candidate.userId,
      orgId: candidate.orgId,
      orchestrator: o.orchestratorId,
      tenantId: o.tenantId,
    });
  }

  // The sync helper never throws; re-raise per-region failures so the
  // candidate is counted as failed and retried on the next run.
  assertRegionSyncSucceeded(outcomes);

  return updated.length > 0 ? 'write_locked' : 'skipped';
}
