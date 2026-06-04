import { getAvailableOrchestrators } from './service-orchestrator-registry';
import type { ServiceOrchestrator } from './service-orchestrator';

export interface ActiveTenant {
  orchestrator: ServiceOrchestrator;
  tenantId: string;
}

export async function getActiveTenant(orgId: string): Promise<ActiveTenant[]> {
  const orchestrators = getAvailableOrchestrators(process.env.FILONE_STAGE!);
  const resolved = await Promise.all(
    orchestrators.map(async (orchestrator) => {
      const tenantId = await orchestrator.isTenantReady(orgId);
      return tenantId ? { orchestrator, tenantId } : null;
    }),
  );
  return resolved.filter((t): t is ActiveTenant => t !== null);
}
