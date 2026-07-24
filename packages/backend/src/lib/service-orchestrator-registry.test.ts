import { describe, it, expect, vi, afterEach } from 'vitest';
import { S3Region, Stage } from '@filone/shared';

// fth-orchestrator builds its FTH management client at import time, so satisfy
// both inputs createInstrumentedFthClient() touches before the registry import
// runs: the baseUrl env var and the SST-linked API token. Forge is built lazily
// (per-region, on first request), so its env/secret only need to exist by the
// time an eu-central-3 lookup happens.
vi.hoisted(() => {
  process.env.FTH_MANAGEMENT_API_URL = 'https://api.fortilyx.test';
  process.env.FORGE_MANAGEMENT_API_URL = 'https://forge.test';
});

vi.mock('sst', () => ({
  Resource: {
    FthManagementApiToken: { value: 'kid.secret' },
    ForgeManagementApiToken: { value: 'fkid.fsecret' },
  },
}));
import {
  getOrchestratorForRegion,
  getAvailableOrchestrators,
} from './service-orchestrator-registry.js';

afterEach(() => {
  delete process.env.FILONE_STAGE;
});

describe('service-orchestrator registry', () => {
  it('routes eu-west-1 to the Aurora orchestrator', () => {
    const orchestrator = getOrchestratorForRegion(S3Region.EuWest1, Stage.Production);
    expect(orchestrator.id).toBe('aurora');
  });

  it('routes us-east-1 to the FTH orchestrator', () => {
    const orchestrator = getOrchestratorForRegion(S3Region.UsEast1, Stage.Production);
    expect(orchestrator.id).toBe('fth');
  });

  it('routes eu-central-3 to Forge Staging orchestrator', () => {
    const orchestrator = getOrchestratorForRegion(S3Region.EuCentral3, Stage.Staging);
    expect(orchestrator.id).toBe('forge');
    expect(orchestrator.region).toBe(S3Region.EuCentral3);
  });
});

describe('getAvailableOrchestrators', () => {
  it('excludes Forge in production', () => {
    const orchestrators = getAvailableOrchestrators(Stage.Production);
    expect(orchestrators.map((o) => o.id)).toStrictEqual(['aurora', 'fth']);
  });

  it('includes the Forge orchestrator on non-production stages', () => {
    const orchestrators = getAvailableOrchestrators(Stage.Staging);
    expect(orchestrators.map((o) => o.id)).toStrictEqual(['aurora', 'fth', 'forge']);
  });
});
