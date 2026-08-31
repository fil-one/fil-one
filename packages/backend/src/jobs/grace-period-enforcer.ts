import { SubscriptionStatus } from '@filone/shared';
import { isOrgDeletedOrDeleting } from '../lib/org-profile.js';
import {
  assertRegionSyncSucceeded,
  syncTenantStatusInProvisionedRegions,
} from '../lib/region-helpers.js';
import { scanSubscriptions, updateSubscriptionByUser } from '../lib/subscription-store.js';

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
  const now = new Date();

  console.log('[grace-period-enforcer] Starting enforcement run', {
    timestamp: now.toISOString(),
  });

  const candidates = await scanGracePeriodCandidates(now.getTime());

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

      const outcome = await processCandidate(candidate, now);
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

async function processCandidate(candidate: Candidate, now: Date): Promise<CandidateOutcome> {
  if (candidate.action === 'cancel') {
    await cancelSubscriptionAndDisableTenant(candidate, now);
    return 'canceled';
  }

  return ensureTenantWriteLocked(candidate);
}

/** Scan for grace_period records, one candidate per org. */
async function scanGracePeriodCandidates(nowMs: number): Promise<Candidate[]> {
  return scanSubscriptions<Candidate>({
    job: 'grace-period-enforcer',
    filterExpression: 'sk = :sk AND subscriptionStatus = :gracePeriod',
    expressionAttributeValues: {
      ':sk': { S: 'SUBSCRIPTION' },
      ':gracePeriod': { S: SubscriptionStatus.GracePeriod },
    },
    select: (record, owner) => {
      const gracePeriodEndsAt = record.gracePeriodEndsAt as string | undefined;
      return {
        ...owner,
        subscriptionStatus: record.subscriptionStatus as string,
        // Grace period expired → cancel + DISABLE. Still active → ensure WRITE_LOCKED.
        action:
          gracePeriodEndsAt && new Date(gracePeriodEndsAt).getTime() < nowMs
            ? 'cancel'
            : 'write_lock',
      };
    },
  });
}

// Grace period expired — disable the tenant on every orchestrator it exists on
// and cancel the subscription. The disable is a probe-first sync: regions that
// are already disabled are skipped, so a partially disabled tenant converges
// on retry. A failed region throws before the cancel write, keeping the record
// in grace_period so the next run retries only the out-of-sync regions. An org
// with no provisioned regions still transitions out of grace (empty outcomes,
// cancel proceeds).
async function cancelSubscriptionAndDisableTenant(candidate: Candidate, now: Date): Promise<void> {
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
