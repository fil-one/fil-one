import pRetry, { type Options as RetryOptions } from 'p-retry';
import { getAvailableOrchestrators } from './service-orchestrator-registry.ts';
import { getOrgProfile } from './org-profile.ts';
import type { RegionOrchestrator } from './service-orchestrator.ts';
import type { TenantStatus } from '@filone/shared/src/api/tenants.ts';

/**
 * A storage network the org is provisioned on, and the tenant it holds there.
 * An orchestrator is one network serving one or more regions, and its tenant is
 * region-free: this is one entry per network, never one per region, so a loop
 * over it touches each tenant once.
 */
export interface ProvisionedNetwork {
  orchestrator: RegionOrchestrator;
  tenantId: string;
}

export async function getProvisionedNetworks(
  orgId: string,
  // Account teardown snapshots tenant ids from here; a stale read there would
  // orphan a live tenant permanently.
  options?: { consistent?: boolean },
): Promise<ProvisionedNetwork[]> {
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
    .filter((t): t is ProvisionedNetwork => t !== null);
}

export interface TenantSyncOutcome {
  orchestratorId: string;
  tenantId: string;
  outcome: 'updated' | 'in-sync' | 'skipped' | 'not-found' | 'error';
  cause?: unknown;
}

// Re-raises per-tenant sync failures as a single error. Callers that need a
// failed sync to abort the surrounding operation (so it is retried as a whole)
// pass the outcomes of syncTenantStatusInProvisionedNetworks through this.
export function assertTenantSyncSucceeded(outcomes: TenantSyncOutcome[]): void {
  const failed = outcomes.filter((o) => o.outcome === 'error');
  if (failed.length > 0) {
    throw new Error(
      `tenant status sync failed for: ${failed.map((o) => o.orchestratorId).join(', ')}`,
      { cause: failed[0].cause },
    );
  }
}

// Every caller can wait out a transient orchestrator outage, so each probe and
// update retries several times (p-retry's default 1s/2s/4s backoff).
const STATUS_SYNC_RETRY: RetryOptions = { retries: 3 };

// Reconciles every provisioned tenant with the desired status. Each tenant's
// live status is its own source of truth: probe first, update only when it
// differs. A tenant that fails to update still differs on the next run, so
// partial failures self-heal. Never throws — per-tenant failures are reported
// as `error` outcomes so callers can record them.
export async function syncTenantStatusInProvisionedNetworks(
  orgId: string,
  desired: TenantStatus,
  options?: { consistent?: boolean },
): Promise<TenantSyncOutcome[]> {
  const ready = await getProvisionedNetworks(orgId, options);

  return Promise.all(
    ready.map(({ orchestrator, tenantId }) =>
      syncRegionTenantStatus({ orgId, orchestrator, tenantId, desired }),
    ),
  );
}

async function syncRegionTenantStatus({
  orgId,
  orchestrator,
  tenantId,
  desired,
}: {
  orgId: string;
  orchestrator: RegionOrchestrator;
  tenantId: string;
  desired: TenantStatus;
}): Promise<TenantSyncOutcome> {
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
    }, STATUS_SYNC_RETRY);

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
    await pRetry(() => orchestrator.updateTenantStatus(tenantId, desired), STATUS_SYNC_RETRY);
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
