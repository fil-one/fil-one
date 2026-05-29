// Cross-orchestrator tenant-status helpers. Locking/unlocking an account, or
// probing where it lives, must reach every orchestrator the org has a tenant on
// (Aurora, FTH, ...) rather than only Aurora.

import { getAvailableOrchestrators } from './service-orchestrator-registry.js';
import type { ServiceOrchestrator, TenantStatus } from './service-orchestrator.js';

export interface ReadyTenant {
  orchestrator: ServiceOrchestrator;
  tenantId: string;
}

// Resolves, for the given org, every available orchestrator that already has a
// ready tenant — paired with that tenant id. Orchestrators where the org has no
// tenant (isTenantReady → null) are omitted. Order follows getAvailableOrchestrators.
export async function resolveReadyTenants(orgId: string): Promise<ReadyTenant[]> {
  const stage = process.env.FILONE_STAGE!;

  const resolved = await Promise.all(
    getAvailableOrchestrators(stage).map(async (orchestrator) => {
      const tenantId = await orchestrator.isTenantReady(orgId);
      return tenantId ? { orchestrator, tenantId } : null;
    }),
  );

  return resolved.filter((entry): entry is ReadyTenant => entry !== null);
}

// Pushes a tenant status change to every orchestrator the org has a tenant on,
// so locking/unlocking an account takes effect everywhere it exists. Replaces
// the duplicated single-call pattern at every billing-driven status-change site.
export async function setTenantStatusAcrossOrchestrators(
  orgId: string,
  status: TenantStatus,
): Promise<void> {
  const ready = await resolveReadyTenants(orgId);

  await Promise.all(
    ready.map(({ orchestrator, tenantId }) => orchestrator.updateTenantStatus(tenantId, status)),
  );
}
