import { getAvailableRegions, isSupportedRegion, S3Region } from '@filone/shared';
import { Resource } from 'sst';
import { auroraOrchestrator } from './aurora/aurora-orchestrator.ts';
import { createForgeOrchestrator, type ForgeManagementApi } from './forge/forge-orchestrator.ts';
import { createFthOrchestrator, createInstrumentedFthClient } from './fth/fth-orchestrator.ts';
import type { ServiceOrchestrator } from './service-orchestrator.ts';

// Aurora is built at import; its module reads no secret while loading. FTH and
// Forge are built lazily on the first request for their region and memoized,
// because construction reads a linked secret. For Forge the secrets are linked
// only on non-production stages, so eager construction would crash production
// at import. For FTH the secret is linked everywhere, and deferring the read
// keeps this module and everything it imports loadable under plain node, where
// bin/ scripts run without `sst shell`. The Forge api config arrives as a thunk
// for the same reason: an argument evaluated at every registry call would touch
// the secret on stages that never link it.
let fthOrchestrator: ServiceOrchestrator | undefined;
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
        fthOrchestrator ??= createFthOrchestrator(createInstrumentedFthClient());
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
