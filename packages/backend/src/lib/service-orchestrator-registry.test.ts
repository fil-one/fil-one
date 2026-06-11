import { describe, it, expect, vi } from 'vitest';
import { S3Region } from '@filone/shared';

// fth-orchestrator builds its FTH management client at import time, so satisfy
// both inputs createInstrumentedFthClient() touches before the registry import
// runs: the baseUrl env var and the SST-linked API token.
vi.hoisted(() => {
  process.env.FTH_MANAGEMENT_API_URL = 'https://api.fortilyx.test';
});

vi.mock('sst', () => ({
  Resource: { FthManagementApiToken: { value: 'kid.secret' } },
}));
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

  it('returns only the Aurora orchestrator in production for a Foundation email', () => {
    const orchestrators = getAvailableOrchestrators('production', 'dogfood@fil.org');
    expect(orchestrators.map((o) => o.id)).toStrictEqual(['aurora']);
  });

  it('returns only the Aurora orchestrator in production for a non-Foundation email', () => {
    const orchestrators = getAvailableOrchestrators('production', 'someone@example.com');
    expect(orchestrators.map((o) => o.id)).toStrictEqual(['aurora']);
  });
});
