import type Stripe from 'stripe';
import { SubscriptionStatus, TRIAL_GRACE_DAYS } from '@filone/shared';
import { emitGraceExpiredWithLiveSubscription } from '../lib/grace-period-metrics.ts';
import { isOrgDeletedOrDeleting } from '../lib/org-profile.ts';
import {
  assertRegionSyncSucceeded,
  syncTenantStatusInProvisionedRegions,
} from '../lib/region-helpers.ts';
import { getStripeClient, isStripeResourceMissing } from '../lib/stripe-client.ts';
import {
  isConditionalCheckFailure,
  scanSubscriptions,
  updateSubscriptionByUser,
} from '../lib/subscription-store.ts';

type Action = 'cancel' | 'write_lock' | 'start_grace';

interface Candidate {
  pk: string;
  userId?: string;
  orgId: string;
  subscriptionId?: string;
  subscriptionStatus: string;
  gracePeriodEndsAt?: string;
  action: Action;
}

/** Statuses of a subscription that is not billing yet that Stripe has not ended. */
const CANCELABLE_STATUSES: ReadonlySet<Stripe.Subscription.Status> = new Set([
  'trialing',
  'paused',
  'past_due',
  'unpaid',
  'incomplete',
]);

/**
 * Whether Stripe still treats the customer as entitled, whatever the row says.
 * A trial is, unless it ends by the grace deadline: a trial's Stripe trial runs
 * through the grace period that follows the row's own, and Stripe ends it then.
 */
function isStillBilling(subscription: Stripe.Subscription, gracePeriodEndsAt: string): boolean {
  if (subscription.status === 'active') return true;
  if (subscription.status !== 'trialing') return false;
  return (subscription.trial_end ?? 0) * 1000 > new Date(gracePeriodEndsAt).getTime();
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
  if (candidate.action === 'cancel') return cancelSubscriptionAndDisableTenant(candidate, now);
  if (candidate.action === 'start_grace') return startTrialGrace(candidate, now);

  return ensureTenantWriteLocked(candidate);
}

/**
 * Scan for grace_period records, and trialing records whose trial has ended,
 * one candidate per org. The console moves an expired trial into grace on the
 * org's next request; an org that only uses its S3 keys never makes one, and
 * Stripe's trial runs on to the grace deadline, so this is what locks it.
 */
async function scanGracePeriodCandidates(nowMs: number): Promise<Candidate[]> {
  return scanSubscriptions<Candidate>({
    job: 'grace-period-enforcer',
    filterExpression:
      'sk = :sk AND (subscriptionStatus = :gracePeriod OR (subscriptionStatus = :trialing AND trialEndsAt < :now))',
    expressionAttributeValues: {
      ':sk': { S: 'SUBSCRIPTION' },
      ':gracePeriod': { S: SubscriptionStatus.GracePeriod },
      ':trialing': { S: SubscriptionStatus.Trialing },
      ':now': { S: new Date(nowMs).toISOString() },
    },
    select: (record, owner) => {
      const subscriptionStatus = record.subscriptionStatus as string;
      if (subscriptionStatus === SubscriptionStatus.Trialing) {
        const trialEndsAt = record.trialEndsAt as string | undefined;
        if (!trialEndsAt || new Date(trialEndsAt).getTime() >= nowMs) return undefined;
        return {
          ...owner,
          subscriptionStatus,
          gracePeriodEndsAt: new Date(
            new Date(trialEndsAt).getTime() + TRIAL_GRACE_DAYS * 24 * 60 * 60 * 1000,
          ).toISOString(),
          action: 'start_grace',
        };
      }
      const gracePeriodEndsAt = record.gracePeriodEndsAt as string | undefined;
      return {
        ...owner,
        subscriptionStatus,
        gracePeriodEndsAt,
        // Grace period expired → cancel + DISABLE. Still active → ensure WRITE_LOCKED.
        action:
          gracePeriodEndsAt && new Date(gracePeriodEndsAt).getTime() < nowMs
            ? 'cancel'
            : 'write_lock',
      };
    },
  });
}

// Grace period expired — disable the tenant on every orchestrator it exists on,
// cancel the Stripe subscription and mark the row canceled. The disable is a
// probe-first sync: regions that are already disabled are skipped, so a
// partially disabled tenant converges on retry. A failed region or Stripe call
// throws before the row write, keeping the record in grace_period so the next
// run retries. An org with no provisioned regions still transitions out of
// grace (empty outcomes, cancel proceeds).
async function cancelSubscriptionAndDisableTenant(
  candidate: Candidate,
  now: Date,
): Promise<CandidateOutcome> {
  const subscription = candidate.subscriptionId
    ? await retrieveIfExists(candidate.subscriptionId)
    : undefined;

  // The row is behind Stripe: a subscription that still bills means the
  // customer is paying, and disabling them is not this job's call.
  // The scan picks the cancel action only for a row whose deadline has passed.
  const gracePeriodEndsAt = candidate.gracePeriodEndsAt!;
  if (subscription && isStillBilling(subscription, gracePeriodEndsAt)) {
    return skipLiveSubscription(candidate, subscription);
  }

  assertRegionSyncSucceeded(
    await syncTenantStatusInProvisionedRegions(candidate.orgId, 'disabled'),
  );

  // Nothing is billed at a cancel that ends a grace period: a trial owes
  // nothing, and an unpaid subscription's open invoices stay open.
  if (subscription && CANCELABLE_STATUSES.has(subscription.status)) {
    // Looked up again: a reactivation can land while the tenant is disabled,
    // and may have re-enabled it before this run's disable reached it.
    const current = await retrieveIfExists(subscription.id);
    if (current && isStillBilling(current, gracePeriodEndsAt)) {
      assertRegionSyncSucceeded(
        await syncTenantStatusInProvisionedRegions(candidate.orgId, 'active'),
      );
      return skipLiveSubscription(candidate, current);
    }
    await getStripeClient().subscriptions.cancel(subscription.id, {
      invoice_now: false,
      prorate: false,
    });
  }

  // Transition DynamoDB status to canceled, only while the row is still in
  // grace: a reactivation since the scan has moved it on.
  await updateSubscriptionByUser(candidate, {
    UpdateExpression: 'SET subscriptionStatus = :status, updatedAt = :now',
    ExpressionAttributeValues: {
      ':status': { S: SubscriptionStatus.Canceled },
      ':now': { S: now.toISOString() },
      ':gracePeriod': { S: SubscriptionStatus.GracePeriod },
    },
    ConditionExpression: 'subscriptionStatus = :gracePeriod',
  });

  console.log('[grace-period-enforcer] Canceled + disabled', {
    userId: candidate.userId,
    orgId: candidate.orgId,
    previousStatus: candidate.subscriptionStatus,
    subscriptionId: candidate.subscriptionId,
  });
  return 'canceled';
}

function skipLiveSubscription(
  candidate: Candidate,
  subscription: Stripe.Subscription,
): CandidateOutcome {
  console.error(
    '[grace-period-enforcer] Grace expired but Stripe still bills the subscription, skipping',
    {
      userId: candidate.userId,
      orgId: candidate.orgId,
      subscriptionId: subscription.id,
      status: subscription.status,
    },
  );
  emitGraceExpiredWithLiveSubscription(subscription.status);
  return 'skipped';
}

async function retrieveIfExists(subscriptionId: string): Promise<Stripe.Subscription | undefined> {
  try {
    return await getStripeClient().subscriptions.retrieve(subscriptionId);
  } catch (err) {
    if (isStripeResourceMissing(err)) return undefined;
    throw err;
  }
}

// Trial expired — move the row into the grace period the console would have
// started, with the same deadline, then write-lock the tenant. Only while the
// row is still trialing: a card added since the scan has ended the trial.
async function startTrialGrace(candidate: Candidate, now: Date): Promise<CandidateOutcome> {
  try {
    await updateSubscriptionByUser(candidate, {
      UpdateExpression:
        'SET subscriptionStatus = :status, gracePeriodEndsAt = :grace, updatedAt = :now',
      ExpressionAttributeValues: {
        ':status': { S: SubscriptionStatus.GracePeriod },
        // The scan sets the deadline on every start_grace candidate.
        ':grace': { S: candidate.gracePeriodEndsAt! },
        ':now': { S: now.toISOString() },
        ':trialing': { S: SubscriptionStatus.Trialing },
      },
      ConditionExpression: 'subscriptionStatus = :trialing',
    });
  } catch (err) {
    if (!isConditionalCheckFailure(err)) throw err;
    return 'skipped';
  }
  return ensureTenantWriteLocked(candidate);
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
