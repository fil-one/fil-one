import pRetry from 'p-retry';
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

const STATUS_PROBE_RETRY = { retries: 3 } as const;

// Reconciles every provisioned region with the desired tenant status. Each
// region's live status is its own source of truth: probe first, update only
// when it differs. A region that fails to update still differs on the next
// run, so partial failures self-heal. Never throws — per-region failures are
// reported as `error` outcomes so callers can record them.
export async function syncTenantStatusInProvisionedRegions(
  orgId: string,
  desired: TenantStatus,
): Promise<RegionSyncOutcome[]> {
  const ready = await getProvisionedRegions(orgId);

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
  orchestrator: ServiceOrchestrator;
  tenantId: string;
  desired: TenantStatus;
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
    }, STATUS_PROBE_RETRY);

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

    await orchestrator.updateTenantStatus(tenantId, desired);
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
