import { describe, it, expect, vi } from 'vitest';
import { S3Region } from '@filone/shared';

vi.hoisted(() => {
  process.env.FILONE_STAGE = 'staging';
});

import { createForgeOrchestrator } from './forge-orchestrator.js';

const api = { baseUrl: 'https://forge.test', accessToken: 'fkid.fsecret' };

describe('createForgeOrchestrator', () => {
  it('builds a region-specific orchestrator with custom ID', () => {
    const orchestrator = createForgeOrchestrator('acme', S3Region.EuCentral3, api);
    expect(orchestrator.id).toBe('acme');
    expect(orchestrator.region).toBe(S3Region.EuCentral3);
  });
});
