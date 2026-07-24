import { getAvailableRegions, S3Region } from '@filone/shared';
import { auroraOrchestrator } from './aurora/aurora-orchestrator.js';
import { createForgeOrchestrator } from './forge/forge-orchestrator.js';
import { fthOrchestrator } from './fth/fth-orchestrator.js';
import type { ServiceOrchestrator } from './service-orchestrator.js';

// Forge orchestrators are built lazily and memoized per region: construction
// reads the ForgeManagementApiToken secret, which is linked only on non-production
// stages. Eager construction (as aurora/fth do) would crash production at import.
const forgeOrchestrators = new Map<S3Region, ServiceOrchestrator>();

function getForgeOrchestrator(region: S3Region): ServiceOrchestrator {
  let orchestrator = forgeOrchestrators.get(region);
  if (!orchestrator) {
    orchestrator = createForgeOrchestrator(region);
    forgeOrchestrators.set(region, orchestrator);
  }
  return orchestrator;
}

export function getOrchestratorForRegion(region: S3Region): ServiceOrchestrator {
  switch (region) {
    case S3Region.EuWest1:
      return auroraOrchestrator;
    case S3Region.UsEast1:
      return fthOrchestrator;
    case S3Region.EuCentral3:
      // Additional Forge regions: add the S3Region value + a case returning
      // getForgeOrchestrator(region) — no other registry change needed.
      return getForgeOrchestrator(region);
    default:
      throw new Error(`Unsupported region "${String(region)}".`);
  }
}

export function getAvailableOrchestrators(): ServiceOrchestrator[] {
  return getAvailableRegions(process.env.FILONE_STAGE).map(getOrchestratorForRegion);
}
