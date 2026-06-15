import pRetry, { type Options as PRetryOptions } from 'p-retry';
import { getAvailableOrchestrators } from './service-orchestrator-registry.js';
import { getOrgProfile } from './org-profile.js';
import type { ServiceOrchestrator, TenantStatus } from './service-orchestrator.js';

export interface ProvisionedRegion {
  orchestrator: ServiceOrchestrator;
  tenantId: string;
}

export async function getProvisionedRegions(orgId: string): Promise<ProvisionedRegion[]> {
  const orchestrators = getAvailableOrchestrators(process.env.FILONE_STAGE!);
  if (orchestrators.length === 0) return [];
  const orgProfile = await getOrgProfile(orgId);
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

// Default for background callers — the grace-period enforcer and usage-reporting
// worker crons (60s timeouts, re-run on schedule) and the activate-subscription
// API. They have generous time budgets, so they ride out transient outages with
// several retries (p-retry's default 1s/2s/4s backoff).
const STATUS_SYNC_RETRY: PRetryOptions = { retries: 3 };

// Override for the Stripe webhook, which awaits this sync synchronously and
// should return 2xx quickly (Stripe's ~2s window). syncRegionTenantStatus probes
// then updates each region (two sequential pRetry calls); with ~200-300ms
// round-trips the worst case (probe succeeds on its retry, then update exhausts
// its retry) is ≈ 2 × (2×300ms + 200ms) ≈ 1.6s — comfortably under ~2s. A
// momentary blip is ridden out; a persistent failure leaves the region out of
// sync until a later billing event re-runs this probe-first sync or the
// grace-period-enforcer cron re-attempts the lock. (The subscription-drift-checker
// only observes drift via telemetry; it does not reconcile.)
export const WEBHOOK_STATUS_SYNC_RETRY: PRetryOptions = { retries: 1, minTimeout: 200 };

// Reconciles every provisioned region with the desired tenant status. Each
// region's live status is its own source of truth: probe first, update only
// when it differs. A region that fails to update still differs on the next
// run, so partial failures self-heal. Never throws — per-region failures are
// reported as `error` outcomes so callers can record them.
export async function syncTenantStatusInProvisionedRegions(
  orgId: string,
  desired: TenantStatus,
  retry: PRetryOptions = STATUS_SYNC_RETRY,
): Promise<RegionSyncOutcome[]> {
  const ready = await getProvisionedRegions(orgId);

  return Promise.all(
    ready.map(({ orchestrator, tenantId }) =>
      syncRegionTenantStatus({ orgId, orchestrator, tenantId, desired, retry }),
    ),
  );
}

async function syncRegionTenantStatus({
  orgId,
  orchestrator,
  tenantId,
  desired,
  retry,
}: {
  orgId: string;
  orchestrator: ServiceOrchestrator;
  tenantId: string;
  desired: TenantStatus;
  retry: PRetryOptions;
}): Promise<RegionSyncOutcome> {
  const base = { orchestratorId: orchestrator.id, tenantId };
  try {
    // getTenantStatus never throws; surface `error` probes as exceptions so
    // pRetry can ride out transient orchestrator outages.
    const probe = await pRetry(async () => {
      const result = await orchestrator.getTenantStatus(tenantId);
      if (result.kind === 'error') {
        throw new Error(`${orchestrator.id} status probe failed for tenant ${tenantId}`, {
          cause: result.cause,
        });
      }
      return result;
    }, retry);

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
    // Retrying at this level keeps the whole status-sync retry budget
    // (probe + update) in one place.
    await pRetry(() => orchestrator.updateTenantStatus(tenantId, desired), retry);
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
