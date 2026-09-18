import { getAvailableRegions, isSupportedRegion, S3Region } from '@filone/shared';
import { Resource } from 'sst';
import { auroraOrchestrator } from './aurora/aurora-orchestrator.ts';
import { createForgeOrchestrator, type ForgeManagementApi } from './forge/forge-orchestrator.ts';
import { createFthOrchestrator, createInstrumentedFthClient } from './fth/fth-orchestrator.ts';
import { ORCHESTRATOR_ID_BY_REGION, regionsForOrchestrator } from './service-orchestrator-ids.ts';
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

// One Forge network per Hilt, keyed by the orchestrator id its regions map to
// in ORCHESTRATOR_ID_BY_REGION. A network is built once and serves every region
// of its id: its tenant is region-free, so the regions share tenant state and
// the console key.
const FORGE_NETWORKS: Record<string, () => ForgeManagementApi> = {
  forge: () => ({
    baseUrl: process.env.FORGE_MANAGEMENT_API_URL!,
    accessToken: Resource.ForgeManagementApiToken.value,
  }),
  forgeDev: () => ({
    baseUrl: process.env.FORGE_DEV_MANAGEMENT_API_URL!,
    accessToken: Resource.ForgeDevManagementApiToken.value,
  }),
};

function getForgeOrchestrator(id: string, stage: string): ServiceOrchestrator {
  let orchestrator = forgeOrchestrators.get(id);
  if (!orchestrator) {
    const api = FORGE_NETWORKS[id];
    if (!api) throw new Error(`No Forge network is configured for orchestrator "${id}".`);
    orchestrator = createForgeOrchestrator(id, regionsForOrchestrator(id, stage), api());
    forgeOrchestrators.set(id, orchestrator);
  }
  return orchestrator;
}

/** The orchestrator (storage network) serving a region. */
export function getOrchestratorForRegion(region: S3Region): ServiceOrchestrator {
  const stage = process.env.FILONE_STAGE!;
  if (isSupportedRegion(region, stage)) {
    switch (region) {
      case S3Region.EuWest1:
        return auroraOrchestrator;
      case S3Region.UsEast1:
        fthOrchestrator ??= createFthOrchestrator(createInstrumentedFthClient());
        return fthOrchestrator;
      default:
        return getForgeOrchestrator(ORCHESTRATOR_ID_BY_REGION[region], stage);
    }
  }
  throw new Error(`Unsupported region "${String(region)}".`);
}

/**
 * Every orchestrator available on this stage, once each and in first-region
 * order. A network serving several regions appears once: its tenant, console
 * key and bucket listing are shared across them, so a per-network loop must
 * not visit it twice.
 */
export function getAvailableOrchestrators(): ServiceOrchestrator[] {
  const stage = process.env.FILONE_STAGE!;
  const seen = new Set<ServiceOrchestrator>();
  for (const region of getAvailableRegions(stage)) seen.add(getOrchestratorForRegion(region));
  return [...seen];
}

/**
 * The orchestrator with this id, or undefined when no network by that id is
 * available on this stage. This is how a stored key row, which records the
 * network that holds its credential, finds its way back to it.
 */
export function findOrchestratorById(id: string): ServiceOrchestrator | undefined {
  return getAvailableOrchestrators().find((orchestrator) => orchestrator.id === id);
}
