import { describe, it, expect } from 'vitest';
import { S3Region } from '@filone/shared';
import { getOrchestrator, orchestratorForRegion } from './registry.js';

describe('service-orchestrator registry', () => {
  it('returns the Aurora orchestrator for id "aurora"', () => {
    const orchestrator = getOrchestrator('aurora');
    expect(orchestrator.id).toBe('aurora');
  });

  it('routes eu-west-1 to the Aurora orchestrator', () => {
    const orchestrator = orchestratorForRegion(S3Region.EuWest1);
    expect(orchestrator.id).toBe('aurora');
  });

  // Phase A: FTH is not yet registered. The mapping in shared/constants.ts
  // still routes us-midwest-1 → 'fth', so calling orchestratorForRegion
  // with that region must throw a clear error rather than silently falling
  // back to Aurora.
  it('throws for us-midwest-1 because FTH is not yet registered', () => {
    expect(() => orchestratorForRegion(S3Region.UsMidwest1)).toThrow(
      /No service orchestrator registered for provider "fth"/,
    );
  });

  it('throws for an unknown provider id', () => {
    expect(() => getOrchestrator('fth')).toThrow(
      /No service orchestrator registered for provider "fth"/,
    );
  });
});
