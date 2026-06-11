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
