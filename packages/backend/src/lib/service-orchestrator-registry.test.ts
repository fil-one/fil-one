import { describe, it, expect, vi, afterEach } from 'vitest';
import { S3Region, Stage, getRegionAccessModel } from '@filone/shared';

// The registry builds every non-Aurora orchestrator lazily, on the first lookup
// for its region. The FTH client reads its baseUrl from the environment and its
// API token from the SST-linked secret at that moment, and each Forge network
// reads its own pair, so all of them are in place before any lookup runs.
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
} from './service-orchestrator-registry.ts';

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

  // Two answers to the same question: the console reads the region's model
  // without an orchestrator in hand, handlers read it off the one they resolved.
  it('agrees with getRegionAccessModel on every region', () => {
    process.env.FILONE_STAGE = Stage.Staging;
    const orchestrators = getAvailableOrchestrators();

    expect(orchestrators.map((o) => [o.region, o.accessModel])).toStrictEqual(
      orchestrators.map((o) => [o.region, getRegionAccessModel(o.region)]),
    );
    expect(orchestrators.map((o) => o.accessModel)).toStrictEqual([
      'scoped-keys',
      'scoped-keys',
      'scoped-keys',
      'scoped-keys',
    ]);
  });
});
