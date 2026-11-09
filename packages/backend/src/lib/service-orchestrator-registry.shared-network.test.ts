import { describe, it, expect, vi, afterEach } from 'vitest';
import { S3Region, Stage } from '@filone/shared';

// Same environment the registry reads when it builds a Forge network lazily.
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

// No two regions share a network today, so the case this file exists for has
// to be arranged: both Forge regions are pointed at one id, and the region
// lookup the registry builds the network from agrees with that.
vi.mock('./service-orchestrator-ids.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./service-orchestrator-ids.ts')>();
  const map = {
    [S3Region.EuWest1]: 'aurora',
    [S3Region.UsEast1]: 'fth',
    [S3Region.EuCentral3]: 'forge',
    [S3Region.UsEast9]: 'forge',
  };
  const { getAvailableRegions } = await import('@filone/shared');
  return {
    ...original,
    ORCHESTRATOR_ID_BY_REGION: map,
    regionsForOrchestrator: (id: string, stage: string) =>
      getAvailableRegions(stage).filter((region) => map[region] === id),
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

    expect(getOrchestratorForRegion(S3Region.UsEast9)).toBe(
      getOrchestratorForRegion(S3Region.EuCentral3),
    );
  });

  it('registers every region it serves, not just the one looked up first', () => {
    process.env.FILONE_STAGE = Stage.Staging;

    const orchestrator = getOrchestratorForRegion(S3Region.EuCentral3);

    expect(orchestrator.regions).toStrictEqual([S3Region.EuCentral3, S3Region.UsEast9]);
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
      S3Region.UsEast9,
    ]);
  });
});
