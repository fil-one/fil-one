import { describe, it, expect, vi, afterEach } from 'vitest';
import { S3Region, Stage } from '@filone/shared';

// Same environment the registry reads when it builds a Forge network lazily.
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

// No two regions share a network today, so the case this file exists for has
// to be arranged. The registry sends eu-west-1 and us-east-1 to Aurora and FTH
// by name, so no other real region can join the Forge network: a made-up one
// does. The cast is the fact the compiler cannot know, that this test adds a
// member to the region list. vi.hoisted makes the values exist before the
// vi.mock factories below, which run ahead of every other top-level statement.
// The region names are literals because S3Region is not imported yet there.
const { SECOND_FORGE_REGION, STAGE_REGIONS } = vi.hoisted(() => {
  const second = 'eu-central-4' as S3Region;
  return {
    SECOND_FORGE_REGION: second,
    STAGE_REGIONS: ['eu-west-1', 'us-east-1', 'eu-central-3', second] as S3Region[],
  };
});

// The stage serves exactly the regions above, the made-up one included, so the
// registry accepts it and lists it with the rest.
vi.mock('@filone/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@filone/shared')>()),
  getAvailableRegions: () => STAGE_REGIONS,
  isSupportedRegion: (region: string) => STAGE_REGIONS.includes(region as S3Region),
}));

// Both Forge regions are pointed at one id, and the region lookup the registry
// builds the network from agrees with that.
vi.mock('./service-orchestrator-ids.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./service-orchestrator-ids.ts')>();
  const map: Record<string, string> = {
    [S3Region.EuWest1]: 'aurora',
    [S3Region.UsEast1]: 'fth',
    [S3Region.EuCentral3]: 'forge',
    [SECOND_FORGE_REGION]: 'forge',
  };
  return {
    ...original,
    ORCHESTRATOR_ID_BY_REGION: map,
    getRegionsForOrchestrator: (id: string) => STAGE_REGIONS.filter((region) => map[region] === id),
  };
});

import {
  getOrchestratorForRegion,
  getAvailableOrchestrators,
  findOrchestratorById,
} from './service-orchestrator-registry.ts';

afterEach(() => {
  delete process.env.FILONE_STAGE;
});

describe('a network serving several regions', () => {
  it('is one orchestrator, whichever of its regions is asked for', () => {
    process.env.FILONE_STAGE = Stage.Staging;

    expect(getOrchestratorForRegion(SECOND_FORGE_REGION)).toBe(
      getOrchestratorForRegion(S3Region.EuCentral3),
    );
  });

  it('registers every region it serves, not just the one looked up first', () => {
    process.env.FILONE_STAGE = Stage.Staging;

    const orchestrator = getOrchestratorForRegion(S3Region.EuCentral3);

    expect(orchestrator.regions).toStrictEqual([S3Region.EuCentral3, SECOND_FORGE_REGION]);
  });

  it('appears once in the available orchestrators', () => {
    process.env.FILONE_STAGE = Stage.Staging;

    const forge = getAvailableOrchestrators().filter((o) => o.id === 'forge');

    expect(forge).toHaveLength(1);
  });

  it('is found by its id from a stored key row', () => {
    process.env.FILONE_STAGE = Stage.Staging;

    expect(findOrchestratorById('forge')?.regions).toStrictEqual([
      S3Region.EuCentral3,
      SECOND_FORGE_REGION,
    ]);
  });
});
