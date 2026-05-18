import type { ProviderId, S3Region } from '@filone/shared';
import { regionToProvider } from '@filone/shared';
import { auroraOrchestrator } from './aurora-orchestrator.js';
import type { ServiceOrchestrator } from './service-orchestrator.js';

// Phase A: only Aurora is registered. Phase B will add the Fortilyx
// orchestrator behind the existing UsMidwest1 → 'fortilyx' mapping in
// shared/constants.ts.
const orchestrators = new Map<ProviderId, ServiceOrchestrator>([['aurora', auroraOrchestrator]]);

export function getOrchestrator(id: ProviderId): ServiceOrchestrator {
  const orchestrator = orchestrators.get(id);
  if (!orchestrator) {
    throw new Error(`No service orchestrator registered for provider "${id}"`);
  }
  return orchestrator;
}

export function orchestratorForRegion(region: S3Region): ServiceOrchestrator {
  return getOrchestrator(regionToProvider(region));
}
