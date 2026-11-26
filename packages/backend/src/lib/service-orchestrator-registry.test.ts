import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { S3Region, Stage } from '@filone/shared';

// The registry builds every non-Aurora orchestrator lazily, on the first lookup
// for its region. The FTH client reads its baseUrl from the environment and its
// API token from the SST-linked secret at that moment, and each Forge network
// reads its own pair, so all of them are in place before any lookup runs.
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
  findOrchestratorById,
  getOrchestratorForRegion,
  getAvailableOrchestrators,
} from './service-orchestrator-registry.ts';
import {
  ORCHESTRATOR_ID_BY_REGION,
  isIamOrchestrator,
  getRegionsForOrchestrator,
} from './service-orchestrator-ids.ts';
import { supportsIamMethods } from '@filone/shared';

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
  it('excludes the Forge orchestrator in production', () => {
    process.env.FILONE_STAGE = Stage.Production;
    const orchestrators = getAvailableOrchestrators();
    expect(orchestrators.map((o) => o.id)).toStrictEqual(['aurora', 'fth']);
  });

  it('includes the Forge orchestrator on non-production stages', () => {
    process.env.FILONE_STAGE = Stage.Staging;
    const orchestrators = getAvailableOrchestrators();
    // Order follows `getAvailableRegions`, which groups by continent
    // (eu-west-1, eu-central-3, us-east-1) rather than by service.
    expect(orchestrators.map((o) => o.id)).toStrictEqual(['aurora', 'forge', 'fth']);
  });
});

describe('findOrchestratorById', () => {
  it('finds an available orchestrator by the id a key row records', () => {
    process.env.FILONE_STAGE = Stage.Staging;
    expect(findOrchestratorById('fth')?.id).toBe('fth');
    expect(findOrchestratorById('forge')?.regions).toStrictEqual([S3Region.EuCentral3]);
  });

  it('answers undefined for a network the stage does not offer', () => {
    process.env.FILONE_STAGE = Stage.Production;
    expect(findOrchestratorById('forge')).toBeUndefined();
    expect(findOrchestratorById('nope')).toBeUndefined();
  });
});

describe('getRegionsForOrchestrator', () => {
  it.each([
    [Stage.Production, 'aurora', [S3Region.EuWest1]],
    [Stage.Production, 'fth', [S3Region.UsEast1]],
    [Stage.Staging, 'forge', [S3Region.EuCentral3]],
  ])('lists what %s serves for %s', (stage, id, expected) => {
    expect(getRegionsForOrchestrator(id, stage)).toStrictEqual(expected);
  });

  it.each([
    // Forge is non-production only, so in production its id serves nothing.
    [Stage.Production, 'forge'],
    [Stage.Staging, 'nope'],
  ])('lists nothing for %s / %s', (stage, id) => {
    expect(getRegionsForOrchestrator(id, stage)).toStrictEqual([]);
  });
});

// Every orchestrator the registry builds serves exactly the regions the ids map
// gives its id, so the two ways of asking agree. One case per orchestrator and
// stage, so a failure names which pair disagreed.
describe.each([Stage.Staging, Stage.Production])('built orchestrators in %s', (stage) => {
  beforeEach(() => {
    process.env.FILONE_STAGE = stage;
  });

  it('serve the regions the ids map gives them', () => {
    for (const orchestrator of getAvailableOrchestrators()) {
      expect({ id: orchestrator.id, regions: orchestrator.regions }).toStrictEqual({
        id: orchestrator.id,
        regions: getRegionsForOrchestrator(orchestrator.id, stage),
      });
    }
  });

  it('agree with the ids map on which orchestrator serves each region', () => {
    for (const orchestrator of getAvailableOrchestrators()) {
      for (const region of orchestrator.regions) {
        expect({ region, id: ORCHESTRATOR_ID_BY_REGION[region] }).toStrictEqual({
          region,
          id: orchestrator.id,
        });
      }
    }
  });
});

describe('isIamOrchestrator', () => {
  // The access model belongs to the network, so reading it off any one of its
  // regions has to give the same answer. Asking the first region is only
  // sound while that holds.
  it('agrees with every region of every built orchestrator', () => {
    process.env.FILONE_STAGE = Stage.Staging;
    for (const orchestrator of getAvailableOrchestrators()) {
      const perRegion = orchestrator.regions.map(supportsIamMethods);
      expect(new Set(perRegion).size).toBe(1);
      expect(isIamOrchestrator(orchestrator)).toBe(perRegion[0]);
    }
  });
});

describe('getOrchestratorForRegion refusals', () => {
  it('refuses a region the stage does not serve', () => {
    process.env.FILONE_STAGE = Stage.Production;
    expect(() => getOrchestratorForRegion(S3Region.EuCentral3)).toThrow(
      /Unsupported region "eu-central-3"/,
    );
  });

  it('refuses a value that is not a region at all', () => {
    process.env.FILONE_STAGE = Stage.Staging;
    expect(() => getOrchestratorForRegion('mars-1' as S3Region)).toThrow(
      /Unsupported region "mars-1"/,
    );
  });
});
