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
  it('builds a region-specific orchestrator (id = forge-<region>)', () => {
    const orchestrator = createForgeOrchestrator(S3Region.EuCentral3);
    expect(orchestrator.id).toBe('forge-eu-central-3');
    expect(orchestrator.region).toBe(S3Region.EuCentral3);
  });

  it('gives each region an isolated id so namespaces never collide', () => {
    const a = createForgeOrchestrator(S3Region.EuCentral3);
    const b = createForgeOrchestrator(S3Region.UsEast1);
    expect(a.id).not.toBe(b.id);
    expect(a.id).toBe('forge-eu-central-3');
    expect(b.id).toBe('forge-us-east-1');
  });
});
