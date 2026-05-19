import { describe, it, expect } from 'vitest';
import { S3Region } from '@filone/shared';
import { getOrchestratorForRegion } from './service-orchestrator-registry.js';

describe('service-orchestrator registry', () => {
  it('routes eu-west-1 to the Aurora orchestrator', () => {
    const orchestrator = getOrchestratorForRegion(S3Region.EuWest1);
    expect(orchestrator.id).toBe('aurora');
  });

  // Phase A: FTH is not yet registered. The mapping in shared/constants.ts
  // still routes us-east-1 → 'fth', so calling orchestratorForRegion
  // with that region must throw a clear error rather than silently falling
  // back to Aurora.
  it('throws for us-east-1 because FTH is not yet registered', () => {
    expect(() => getOrchestratorForRegion(S3Region.UsEast1)).toThrow(
      /No service orchestrator registered for region "us-east-1"/,
    );
  });
});
