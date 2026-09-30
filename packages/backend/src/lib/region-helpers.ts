import pRetry, { type Options as RetryOptions } from 'p-retry';
import { getAvailableOrchestrators } from './service-orchestrator-registry.ts';
import { getOrgProfile } from './org-profile.ts';
import type { ServiceOrchestrator } from './service-orchestrator.ts';
import type { TenantStatus } from '@filone/shared/src/api/tenants.ts';

export interface ProvisionedRegion {
  orchestrator: ServiceOrchestrator;
  tenantId: string;
}

export async function getProvisionedRegions(
  orgId: string,
  // Account teardown snapshots tenant ids from here; a stale read there would
  // orphan a live tenant permanently.
  options?: { consistent?: boolean },
): Promise<ProvisionedRegion[]> {
  const orchestrators = getAvailableOrchestrators();
  if (orchestrators.length === 0) return [];
  const orgProfile = await getOrgProfile(
    orgId,
    options ? { consistentRead: options.consistent } : undefined,
  );
  return orchestrators
    .map((orchestrator) => {
      const tenantId = orchestrator.isTenantReady(orgProfile);
      return tenantId ? { orchestrator, tenantId } : null;
    })
    .filter((t): t is ProvisionedRegion => t !== null);
}

export interface RegionSyncOutcome {
  orchestratorId: string;
  tenantId: string;
  outcome: 'updated' | 'in-sync' | 'skipped' | 'not-found' | 'error';
  cause?: unknown;
}

// Re-raises per-region sync failures as a single error. Callers that need a
// failed sync to abort the surrounding operation (so it is retried as a whole)
// pass the outcomes of syncTenantStatusInProvisionedRegions through this.
export function assertRegionSyncSucceeded(outcomes: RegionSyncOutcome[]): void {
  const failed = outcomes.filter((o) => o.outcome === 'error');
  if (failed.length > 0) {
    throw new Error(
      `tenant status sync failed for: ${failed.map((o) => o.orchestratorId).join(', ')}`,
      { cause: failed[0].cause },
    );
  }
}

// Default for callers that can afford to ride out a transient outage: the
// grace-period enforcer and usage-reporting worker crons, which re-run on
// schedule, and the account teardown. Three retries on p-retry's default
// 1s/2s/4s backoff. What stops the loop is the caller's signal, so
// activate-subscription can take this default inside its 10 s route.
const STATUS_SYNC_RETRY: RetryOptions = { retries: 3 };

// Override for the Stripe webhook, which awaits this sync synchronously and
// should return 2xx quickly (Stripe's ~2s window). One retry rides out a
// momentary blip; a persistent failure leaves the region out of sync until a
// later billing event re-runs this probe-first sync or the grace-period-enforcer
// cron re-attempts the lock. (The subscription-drift-checker only observes drift
// via telemetry; it does not reconcile.) What actually keeps the webhook inside
// its Lambda is the caller's signal, not this count: retries here restart, so
// the count alone bounds nothing.
export const WEBHOOK_STATUS_SYNC_RETRY: RetryOptions = { retries: 1, minTimeout: 200 };

export interface StatusSyncOptions {
  signal: AbortSignal;
  retry?: RetryOptions;
}

// Reconciles every provisioned region with the desired tenant status. Each
// region's live status is its own source of truth: probe first, update only
// when it differs. A region that fails to update still differs on the next
// run, so partial failures self-heal. Never throws — per-region failures are
// reported as `error` outcomes so callers can record them.
export async function syncTenantStatusInProvisionedRegions(
  orgId: string,
  desired: TenantStatus,
  // The caller's deadline, which is what bounds the sync: every attempt shares
  // it, so the retry loop ends when it expires instead of starting another
  // attempt under a fresh one. Required, because the retry count on its own
  // says nothing about how long this can run.
  { signal, retry = STATUS_SYNC_RETRY }: StatusSyncOptions,
): Promise<RegionSyncOutcome[]> {
  const ready = await getProvisionedRegions(orgId);

  return Promise.all(
    ready.map(({ orchestrator, tenantId }) =>
      syncRegionTenantStatus({ orgId, orchestrator, tenantId, desired, retry, signal }),
    ),
  );
}

async function syncRegionTenantStatus({
  orgId,
  orchestrator,
  tenantId,
  desired,
  retry,
  signal,
}: {
  orgId: string;
  orchestrator: ServiceOrchestrator;
  tenantId: string;
  desired: TenantStatus;
  retry: RetryOptions;
  signal: AbortSignal;
}): Promise<RegionSyncOutcome> {
  const base = { orchestratorId: orchestrator.id, tenantId };
  try {
    // getTenantStatus never throws; surface `error` probes as exceptions so
    // pRetry can ride out transient orchestrator outages. The caller's signal
    // goes to both the probe and pRetry itself, so an expired deadline ends the
    // loop rather than being handed to another attempt.
    const probe = await pRetry(
      async () => {
        const result = await orchestrator.getTenantStatus(tenantId, { signal });
        if (result.kind === 'error') {
          throw new Error(`${orchestrator.id} status probe failed for tenant ${tenantId}`, {
            cause: result.cause,
          });
        }
        return result;
      },
      { ...retry, signal },
    );

    if (probe.kind === 'not_found') {
      console.warn('[region-helpers] tenant not found, skipping status sync', {
        orgId,
        orchestrator: orchestrator.id,
        tenantId,
      });
      return { ...base, outcome: 'not-found' };
    }

    if (probe.status === desired) {
      return { ...base, outcome: 'in-sync' };
    }

    // Never downgrade a disabled tenant to write-locked. `disabled` is the
    // stronger lock; it must only be lifted by an explicit re-activation
    // (desired = 'active').
    if (probe.status === 'disabled' && desired === 'write-locked') {
      return { ...base, outcome: 'skipped' };
    }

    // A status update sets an absolute value (idempotent), so transient
    // failures are safe to retry here rather than inside each orchestrator.
    // Retrying at this level keeps the probe's retry policy and the update's
    // in one place.
    await pRetry(() => orchestrator.updateTenantStatus(tenantId, desired, { signal }), {
      ...retry,
      signal,
    });
    return { ...base, outcome: 'updated' };
  } catch (cause) {
    console.error('[region-helpers] tenant status sync failed', {
      orgId,
      orchestrator: orchestrator.id,
      tenantId,
      desired,
      cause,
    });
    return { ...base, outcome: 'error', cause };
  }
}
