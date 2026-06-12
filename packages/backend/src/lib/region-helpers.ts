import { getAvailableOrchestrators } from './service-orchestrator-registry';
import type { ServiceOrchestrator } from './service-orchestrator';

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
