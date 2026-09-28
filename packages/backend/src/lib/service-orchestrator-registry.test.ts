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
  findOrchestratorById,
  getOrchestratorForRegion,
  getAvailableOrchestrators,
} from './service-orchestrator-registry.ts';
import { ORCHESTRATOR_ID_BY_REGION, regionsForOrchestrator } from './service-orchestrator-ids.ts';

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
    expect(orchestrator.regions).toStrictEqual([S3Region.EuCentral3]);
  });

  it('routes us-east-9 to the Forge dev sandbox orchestrator', () => {
    process.env.FILONE_STAGE = Stage.Staging;
    const orchestrator = getOrchestratorForRegion(S3Region.UsEast9);
    expect(orchestrator.id).toBe('forgeDev');
    expect(orchestrator.regions).toStrictEqual([S3Region.UsEast9]);
  });

  // The ids map is the answer for code that cannot build an orchestrator, so
  // it must agree with the orchestrators the registry does build.
  for (const [region, id] of Object.entries(ORCHESTRATOR_ID_BY_REGION)) {
    it(`builds the orchestrator named by ORCHESTRATOR_ID_BY_REGION for ${region}`, () => {
      process.env.FILONE_STAGE = Stage.Staging;
      expect(getOrchestratorForRegion(region as S3Region).id).toBe(id);
    });
  }
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

    expect(orchestrators.flatMap((o) => o.regions.map((r) => [r, o.accessModel]))).toStrictEqual(
      orchestrators.flatMap((o) => o.regions.map((r) => [r, getRegionAccessModel(r)])),
    );
    expect(orchestrators.map((o) => o.accessModel)).toStrictEqual([
      'scoped-keys',
      'scoped-keys',
      'scoped-keys',
      'scoped-keys',
    ]);
  });
});

describe('findOrchestratorById', () => {
  it('finds an available orchestrator by the id a key row records', () => {
    process.env.FILONE_STAGE = Stage.Staging;
    expect(findOrchestratorById('fth')?.id).toBe('fth');
    expect(findOrchestratorById('forgeDev')?.regions).toStrictEqual([S3Region.UsEast9]);
  });

  it('answers undefined for a network the stage does not offer', () => {
    process.env.FILONE_STAGE = Stage.Production;
    expect(findOrchestratorById('forge')).toBeUndefined();
    expect(findOrchestratorById('nope')).toBeUndefined();
  });
});

describe('regionsForOrchestrator', () => {
  it('lists the regions an id serves on the stage, and none for an unknown id', () => {
    expect(regionsForOrchestrator('aurora', Stage.Production)).toStrictEqual([S3Region.EuWest1]);
    expect(regionsForOrchestrator('forge', Stage.Staging)).toStrictEqual([S3Region.EuCentral3]);
    expect(regionsForOrchestrator('forge', Stage.Production)).toStrictEqual([]);
    expect(regionsForOrchestrator('nope', Stage.Staging)).toStrictEqual([]);
  });

  // Every orchestrator the registry builds serves exactly the regions the ids
  // map gives its id, so the two ways of asking agree.
  it('agrees with the regions of every built orchestrator', () => {
    process.env.FILONE_STAGE = Stage.Staging;
    for (const orchestrator of getAvailableOrchestrators()) {
      expect(orchestrator.regions).toStrictEqual(
        regionsForOrchestrator(orchestrator.id, Stage.Staging),
      );
    }
  });
});
