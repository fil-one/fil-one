import { getAvailableRegions, S3Region } from '@filone/shared';
import { auroraOrchestrator } from './aurora/aurora-orchestrator.js';
import { fthOrchestrator } from './fth/fth-orchestrator.js';
import type { ServiceOrchestrator } from './service-orchestrator.js';

export function getOrchestratorForRegion(region: S3Region): ServiceOrchestrator {
  switch (region) {
    case S3Region.EuWest1:
      return auroraOrchestrator;
    case S3Region.UsEast1:
      return fthOrchestrator;
    default:
      throw new Error(`Unsupported region "${String(region)}".`);
  }
}

export function getOrchestratorsForCurrentStage(): ServiceOrchestrator[] {
  const stage = process.env.FILONE_STAGE!;
  return getAvailableRegions(stage).map(getOrchestratorForRegion);
}
