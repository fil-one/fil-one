import { S3Region } from '@filone/shared';
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
      throw new Error(`No service orchestrator registered for region "${String(region)}"`);
  }
}
