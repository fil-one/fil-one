import { afterEach, describe, it, expect } from 'vitest';
import { S3Region } from '@filone/shared';
import {
  getOrchestratorForRegion,
  getOrchestratorsForCurrentStage,
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

describe('getOrchestratorsForCurrentStage', () => {
  const originalStage = process.env.FILONE_STAGE;

  afterEach(() => {
    process.env.FILONE_STAGE = originalStage;
  });

  it('returns only the Aurora orchestrator in production', () => {
    process.env.FILONE_STAGE = 'production';
    const orchestrators = getOrchestratorsForCurrentStage();
    expect(orchestrators.map((o) => o.id)).toStrictEqual(['aurora']);
  });

  it('returns Aurora and FTH orchestrators in non-production stages', () => {
    process.env.FILONE_STAGE = 'staging';
    const orchestrators = getOrchestratorsForCurrentStage();
    expect(orchestrators.map((o) => o.id)).toStrictEqual(['aurora', 'fth']);
  });
});
