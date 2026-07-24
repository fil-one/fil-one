import { getAvailableRegions, S3Region, Stage } from '@filone/shared';
import { auroraOrchestrator } from './aurora/aurora-orchestrator.js';
import { createForgeOrchestrator } from './forge/forge-orchestrator.js';
import { fthOrchestrator } from './fth/fth-orchestrator.js';
import type { ServiceOrchestrator } from './service-orchestrator.js';

// Forge orchestrators are built lazily and memoized per region: construction
// reads the ForgeManagementApiToken secret, which is linked only on non-production
// stages. Eager construction (as aurora/fth do) would crash production at import.
const forgeOrchestrators = new Map<string, ServiceOrchestrator>();

function getForgeOrchestrator(id: string, region: S3Region): ServiceOrchestrator {
  let orchestrator = forgeOrchestrators.get(id);
  if (!orchestrator) {
    orchestrator = createForgeOrchestrator(id, region);
    forgeOrchestrators.set(id, orchestrator);
  }
  return orchestrator;
}

export function getOrchestratorForRegion(region: S3Region): ServiceOrchestrator {
  const stage = process.env.FILONE_STAGE!;
  switch (region) {
    case S3Region.EuWest1:
      return auroraOrchestrator;
    case S3Region.UsEast1:
      return fthOrchestrator;
    case S3Region.EuCentral3:
      if (stage !== Stage.Production) {
        return getForgeOrchestrator('forge', region);
      }
      break;
  }
  throw new Error(`Unsupported region "${String(region)}".`);
}

export function getAvailableOrchestrators(): ServiceOrchestrator[] {
  const stage = process.env.FILONE_STAGE!;
  return getAvailableRegions(stage).map(getOrchestratorForRegion);
}
