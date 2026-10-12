import { afterEach, describe, expect, it, vi } from 'vitest';
import { getNetworkAccessModels } from './network-access-model.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getNetworkAccessModels', () => {
  it('reads each network from its own variable', () => {
    vi.stubEnv('FORGE_ACCESS_MODEL', 'service-keys');
    vi.stubEnv('FORGE_DEV_ACCESS_MODEL', 'iam');

    expect(getNetworkAccessModels()).toStrictEqual({ forge: 'service-keys', forgeDev: 'iam' });
  });

  it('answers service-keys for a network whose variable is unset', () => {
    vi.stubEnv('FORGE_ACCESS_MODEL', undefined);
    vi.stubEnv('FORGE_DEV_ACCESS_MODEL', undefined);

    expect(getNetworkAccessModels()).toStrictEqual({
      forge: 'service-keys',
      forgeDev: 'service-keys',
    });
  });
});
