import { getAvailableRegions, S3Region, Stage } from '@filone/shared';
import { auroraOrchestrator } from './aurora/aurora-orchestrator.js';
import { createForgeOrchestrator } from './forge/forge-orchestrator.js';
import { fthOrchestrator } from './fth/fth-orchestrator.js';
import type { ServiceOrchestrator } from './service-orchestrator.js';

export function getOrchestratorForRegion(
  region: S3Region,
  stage: Stage | string,
): ServiceOrchestrator {
  switch (region) {
    case S3Region.EuWest1:
      return auroraOrchestrator;
    case S3Region.UsEast1:
      return fthOrchestrator;
    case S3Region.EuCentral3:
      if (stage !== Stage.Production) {
        return createForgeOrchestrator('forge', region);
      }
      break;
  }
  throw new Error(`Unsupported region "${String(region)}".`);
}

export function getAvailableOrchestrators(stage: Stage | string): ServiceOrchestrator[] {
  return getAvailableRegions(stage).map((r) => getOrchestratorForRegion(r, stage));
}
