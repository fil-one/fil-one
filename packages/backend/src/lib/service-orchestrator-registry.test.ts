import { describe, it, expect } from 'vitest';
import { S3Region } from '@filone/shared';
import {
  getOrchestratorForRegion,
  getAvailableOrchestrators,
} from './service-orchestrator-registry.js';

describe('service-orchestrator registry', () => {
  it('routes eu-west-1 to the Aurora orchestrator', () => {
    const orchestrator = getOrchestratorForRegion(S3Region.EuWest1);
    expect(orchestrator.id).toBe('aurora');
  });

  it('routes us-east-1 to the FTH orchestrator', () => {
    const orchestrator = getOrchestratorForRegion(S3Region.UsEast1);
    expect(orchestrator.id).toBe('fth');
  });
});

describe('getAvailableOrchestrators', () => {
  it('returns only the Aurora orchestrator in production', () => {
    const orchestrators = getAvailableOrchestrators('production');
    expect(orchestrators.map((o) => o.id)).toStrictEqual(['aurora']);
  });

  it('returns Aurora and FTH orchestrators in non-production stages', () => {
    const orchestrators = getAvailableOrchestrators('staging');
    expect(orchestrators.map((o) => o.id)).toStrictEqual(['aurora', 'fth']);
  });
});
