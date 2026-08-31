import { describe, it, expect, vi, afterEach } from 'vitest';
import { S3Region, Stage } from '@filone/shared';

// fth-orchestrator builds its FTH management client at import time, so satisfy
// both inputs createInstrumentedFthClient() touches before the registry import
// runs: the baseUrl env var and the SST-linked API token. Forge is built lazily
// (per-region, on first request), so each Forge network's env/secret only needs
// to exist by the time a lookup for one of its regions happens.
vi.hoisted(() => {
  process.env.FTH_MANAGEMENT_API_URL = 'https://api.fortilyx.test';
  process.env.FORGE_MANAGEMENT_API_URL = 'https://forge.test';
  process.env.FORGE_DEV_MANAGEMENT_API_URL = 'https://forge-dev.test';
});

vi.mock('sst', () => ({
  Resource: {
    FthManagementApiToken: { value: 'kid.secret' },
    ForgeManagementApiToken: { value: 'fkid.fsecret' },
    ForgeDevManagementApiToken: { value: 'dkid.dsecret' },
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
    process.env.FILONE_STAGE = Stage.Production;
    const orchestrator = getOrchestratorForRegion(S3Region.EuWest1);
    expect(orchestrator.id).toBe('aurora');
  });

  it('routes us-east-1 to the FTH orchestrator', () => {
    process.env.FILONE_STAGE = Stage.Production;
    const orchestrator = getOrchestratorForRegion(S3Region.UsEast1);
    expect(orchestrator.id).toBe('fth');
  });

  it('routes eu-central-3 to Forge Staging orchestrator', () => {
    process.env.FILONE_STAGE = Stage.Staging;
    const orchestrator = getOrchestratorForRegion(S3Region.EuCentral3);
    expect(orchestrator.id).toBe('forge');
    expect(orchestrator.region).toBe(S3Region.EuCentral3);
  });

  it('routes us-east-9 to the Forge dev sandbox orchestrator', () => {
    process.env.FILONE_STAGE = Stage.Staging;
    const orchestrator = getOrchestratorForRegion(S3Region.UsEast9);
    expect(orchestrator.id).toBe('forgeDev');
    expect(orchestrator.region).toBe(S3Region.UsEast9);
  });
});

describe('getAvailableOrchestrators', () => {
  it('excludes the Forge orchestrators in production', () => {
    process.env.FILONE_STAGE = Stage.Production;
    const orchestrators = getAvailableOrchestrators();
    expect(orchestrators.map((o) => o.id)).toStrictEqual(['aurora', 'fth']);
  });

  it('includes both Forge orchestrators on non-production stages', () => {
    process.env.FILONE_STAGE = Stage.Staging;
    const orchestrators = getAvailableOrchestrators();
    expect(orchestrators.map((o) => o.id)).toStrictEqual(['aurora', 'fth', 'forge', 'forgeDev']);
  });
});
