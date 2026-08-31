import { getAvailableRegions, isSupportedRegion, S3Region } from '@filone/shared';
import { Resource } from 'sst';
import { auroraOrchestrator } from './aurora/aurora-orchestrator.js';
import { createForgeOrchestrator, type ForgeManagementApi } from './forge/forge-orchestrator.js';
import { fthOrchestrator } from './fth/fth-orchestrator.js';
import type { ServiceOrchestrator } from './service-orchestrator.js';

// Forge orchestrators are built lazily and memoized per id (unique per region):
// construction reads a Forge token secret, which is linked only on non-production
// stages. Eager construction (as aurora/fth do) would crash production at import.
// The api config arrives as a thunk for the same reason — an argument evaluated at
// every registry call would touch the secret on stages that never link it.
const forgeOrchestrators = new Map<string, ServiceOrchestrator>();

function getForgeOrchestrator(
  id: string,
  region: S3Region,
  api: () => ForgeManagementApi,
): ServiceOrchestrator {
  let orchestrator = forgeOrchestrators.get(id);
  if (!orchestrator) {
    orchestrator = createForgeOrchestrator(id, region, api());
    forgeOrchestrators.set(id, orchestrator);
  }
  return orchestrator;
}

export function getOrchestratorForRegion(region: S3Region): ServiceOrchestrator {
  const stage = process.env.FILONE_STAGE!;
  if (isSupportedRegion(region, stage)) {
    switch (region) {
      case S3Region.EuWest1:
        return auroraOrchestrator;
      case S3Region.UsEast1:
        return fthOrchestrator;
      case S3Region.EuCentral3:
        return getForgeOrchestrator('forge', region, () => ({
          baseUrl: process.env.FORGE_MANAGEMENT_API_URL!,
          accessToken: Resource.ForgeManagementApiToken.value,
        }));
      case S3Region.UsEast9:
        return getForgeOrchestrator('forgeDev', region, () => ({
          baseUrl: process.env.FORGE_DEV_MANAGEMENT_API_URL!,
          accessToken: Resource.ForgeDevManagementApiToken.value,
        }));
    }
  }
  throw new Error(`Unsupported region "${String(region)}".`);
}

export function getAvailableOrchestrators(): ServiceOrchestrator[] {
  const stage = process.env.FILONE_STAGE!;
  return getAvailableRegions(stage).map(getOrchestratorForRegion);
}
