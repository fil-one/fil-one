import { afterEach, describe, expect, it, vi } from 'vitest';
import { getNetworkAccessModels } from './access-model.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getNetworkAccessModels', () => {
  it('reads each network from its own build variable', () => {
    vi.stubEnv('VITE_FORGE_ACCESS_MODEL', 'iam');
    vi.stubEnv('VITE_FORGE_DEV_ACCESS_MODEL', 'service-keys');

    expect(getNetworkAccessModels()).toStrictEqual({ forge: 'iam', forgeDev: 'service-keys' });
  });
});
