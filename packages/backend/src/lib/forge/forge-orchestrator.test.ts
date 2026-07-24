import { describe, it, expect, vi } from 'vitest';
import { S3Region } from '@filone/shared';

vi.hoisted(() => {
  process.env.FILONE_STAGE = 'staging';
  process.env.FORGE_MANAGEMENT_API_URL = 'https://forge.test';
});

vi.mock('sst', () => ({
  Resource: { ForgeManagementApiToken: { value: 'fkid.fsecret' } },
}));

import { createForgeOrchestrator } from './forge-orchestrator.js';

describe('createForgeOrchestrator', () => {
  it('builds a region-specific orchestrator with custom ID', () => {
    const orchestrator = createForgeOrchestrator('acme', S3Region.EuCentral3);
    expect(orchestrator.id).toBe('acme');
    expect(orchestrator.region).toBe(S3Region.EuCentral3);
  });
});
