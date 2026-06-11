import pRetry from 'p-retry';
import { getAvailableOrchestrators } from './service-orchestrator-registry';
import type { ServiceOrchestrator, TenantStatus } from './service-orchestrator';

export interface ProvisionedRegion {
  orchestrator: ServiceOrchestrator;
  tenantId: string;
}

export async function getProvisionedRegions(orgId: string): Promise<ProvisionedRegion[]> {
  const orchestrators = getAvailableOrchestrators(process.env.FILONE_STAGE!);
  const resolved = await Promise.all(
    orchestrators.map(async (orchestrator) => {
      const tenantId = await orchestrator.isTenantReady(orgId);
      return tenantId ? { orchestrator, tenantId } : null;
    }),
  );
  return resolved.filter((t): t is ProvisionedRegion => t !== null);
}

// Pushes a tenant status change to every orchestrator the org has a tenant on,
// so locking/unlocking an account takes effect everywhere it exists. Replaces
// the duplicated single-call pattern at every billing-driven status-change site.
export async function setTenantStatusInProvisionedRegions(
  orgId: string,
  status: TenantStatus,
): Promise<void> {
  const ready = await getProvisionedRegions(orgId);

  await Promise.all(
    ready.map(({ orchestrator, tenantId }) => orchestrator.updateTenantStatus(tenantId, status)),
  );
}

export interface RegionSyncOutcome {
  orchestratorId: string;
  tenantId: string;
  outcome: 'updated' | 'in-sync' | 'not-found' | 'error';
  cause?: unknown;
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
