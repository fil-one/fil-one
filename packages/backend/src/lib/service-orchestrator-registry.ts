import { S3Region } from '@filone/shared';
import { auroraOrchestrator } from './aurora/aurora-orchestrator.js';
import type { ServiceOrchestrator } from './service-orchestrator.js';

export function getOrchestratorForRegion(region: S3Region): ServiceOrchestrator {
  switch (region) {
    case S3Region.EuWest1:
      return auroraOrchestrator;
    default:
      throw new Error(`No service orchestrator registered for region "${region}"`);
  }
}
