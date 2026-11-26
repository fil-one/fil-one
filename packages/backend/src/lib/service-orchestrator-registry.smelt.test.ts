import { describe, it, expect, vi } from 'vitest';
import { S3Region } from '@filone/shared';

// A SMELT=true deploy sets these (forgeEnv in sst.config.ts). The registry
// builds each Forge network once, on the first lookup, so they are in place
// before any test runs. Any non-production stage serves eu-central-3.
vi.hoisted(() => {
  process.env.FILONE_STAGE = 'local';
  process.env.FTH_MANAGEMENT_API_URL = 'https://api.fortilyx.test';
  process.env.FORGE_MANAGEMENT_API_URL = 'http://host.docker.internal:15110';
  process.env.FORGE_S3_ENDPOINT_URL = 'http://host.docker.internal:15130';
  process.env.FORGE_S3_PRESIGN_ENDPOINT_URL = 'http://localhost:15130';
});

vi.mock('sst', () => ({
  Resource: {
    FthManagementApiToken: { value: 'kid.secret' },
    ForgeManagementApiToken: { value: 'any-partner-key' },
  },
}));

const { createForgeOrchestrator } = vi.hoisted(() => ({
  createForgeOrchestrator: vi.fn((id: string, regions: string[]) => ({ id, regions })),
}));
vi.mock('./forge/forge-orchestrator.ts', () => ({ createForgeOrchestrator }));

import { getOrchestratorForRegion } from './service-orchestrator-registry.ts';

describe('the Forge network on a stage deployed against smelt', () => {
  it('sends eu-central-3 to the smelt gateway, with presigned URLs on localhost', () => {
    getOrchestratorForRegion(S3Region.EuCentral3);

    expect(createForgeOrchestrator).toHaveBeenCalledWith(
      'forge',
      [S3Region.EuCentral3],
      { baseUrl: 'http://host.docker.internal:15110', accessToken: 'any-partner-key' },
      {
        [S3Region.EuCentral3]: {
          endpointUrl: 'http://host.docker.internal:15130',
          presignEndpointUrl: 'http://localhost:15130',
        },
      },
    );
  });
});
