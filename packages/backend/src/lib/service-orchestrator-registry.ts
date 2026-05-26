import { getAvailableRegions, S3Region, type Stage } from '@filone/shared';
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

export function getAvailableOrchestrators(stage: Stage | string): ServiceOrchestrator[] {
  return getAvailableRegions(stage).map(getOrchestratorForRegion);
}
