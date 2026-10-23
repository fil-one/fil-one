import { describe, expect, it } from 'vitest';
import type { GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
import { S3Region } from '@filone/shared';

import {
  applyShellOverrides,
  getNetworkForRegion,
  isForgeNetworkName,
  parseSecretList,
  readLambdaEnv,
  type LambdaConfigReader,
} from './forge-network.ts';

describe('parseSecretList', () => {
  const output = [
    '# filone/any-stage',
    'OtherSecret=other-value',
    'AnySecret=any-value',
    'WithEquals=a=b',
    '# filone/another-stage',
    'StageOnlySecret=wrong-stage-value',
    '',
  ].join('\n');

  it.each([
    { name: 'AnySecret', expected: 'any-value' },
    // Only the first "=" separates the name from the value.
    { name: 'WithEquals', expected: 'a=b' },
    { name: 'MissingSecret', expected: undefined },
    // Listed, but under another stage's header.
    { name: 'StageOnlySecret', expected: undefined },
  ])('returns $expected for $name', ({ name, expected }) => {
    expect(parseSecretList(output, 'any-stage', name)).toBe(expected);
  });

  it('returns undefined when the output has no header for the stage', () => {
    expect(parseSecretList('AnySecret=any-value\n', 'any-stage', 'AnySecret')).toBeUndefined();
  });

  it('returns the fallback value when the stage has no value of its own', () => {
    const withFallback = ['# fallback', 'AnySecret=fallback-value', '', '# filone/any-stage', ''];
    expect(parseSecretList(withFallback.join('\n'), 'any-stage', 'AnySecret')).toBe(
      'fallback-value',
    );
  });

  it("returns the stage's value over the fallback value", () => {
    const withBoth = [
      '# fallback',
      'AnySecret=fallback-value',
      '',
      '# filone/any-stage',
      'AnySecret=stage-value',
      '',
    ];
    expect(parseSecretList(withBoth.join('\n'), 'any-stage', 'AnySecret')).toBe('stage-value');
  });
});

describe('applyShellOverrides', () => {
  it.each([
    { shell: { ANY_URL: 'http://localhost:1' }, expected: 'http://localhost:1' },
    { shell: {}, expected: 'http://deployed:1' },
    // An empty variable is treated as unset.
    { shell: { ANY_URL: '' }, expected: 'http://deployed:1' },
  ])('returns $expected when the shell has $shell', ({ shell, expected }) => {
    expect(applyShellOverrides({ ANY_URL: 'http://deployed:1' }, shell)).toStrictEqual({
      ANY_URL: expected,
    });
  });

  it('ignores shell variables the deployed environment was not asked for', () => {
    expect(applyShellOverrides({ ANY_URL: undefined }, { OTHER: 'other-value' })).toStrictEqual({
      ANY_URL: undefined,
    });
  });
});

describe('readLambdaEnv', () => {
  function stubLambda(variables: Record<string, string> | undefined): LambdaConfigReader {
    return {
      send: async (command: GetFunctionConfigurationCommand) => {
        if (command.input.FunctionName !== 'any-function') throw new Error('unexpected function');
        return { Environment: variables && { Variables: variables }, $metadata: {} };
      },
    };
  }

  it('returns only the requested variables', async () => {
    const lambda = stubLambda({ WANTED: 'wanted-value', SECRET_KEY: 'other-value' });
    await expect(readLambdaEnv(lambda, 'any-function', ['WANTED'])).resolves.toStrictEqual({
      WANTED: 'wanted-value',
    });
  });

  it('returns undefined for a variable the function does not have', async () => {
    const lambda = stubLambda({ OTHER: 'other-value' });
    await expect(readLambdaEnv(lambda, 'any-function', ['WANTED'])).resolves.toStrictEqual({
      WANTED: undefined,
    });
  });

  it('returns undefined for every variable when the function has no environment', async () => {
    await expect(
      readLambdaEnv(stubLambda(undefined), 'any-function', ['WANTED']),
    ).resolves.toStrictEqual({ WANTED: undefined });
  });
});

describe('FORGE_NETWORKS', () => {
  it.each([
    { network: 'staging', region: S3Region.EuCentral3 },
    { network: 'dev', region: S3Region.UsEast9 },
  ] as const)('maps region $region to network $network', ({ network, region }) => {
    expect(getNetworkForRegion(region)).toBe(network);
  });

  it('returns no network for a region outside Forge', () => {
    expect(getNetworkForRegion(S3Region.EuWest1)).toBeUndefined();
  });

  it.each(['staging', 'dev'])('accepts %s as a network name', (name) => {
    expect(isForgeNetworkName(name)).toBe(true);
  });

  it.each([
    'production',
    // An Object.prototype key, which a plain `in` check would accept.
    'toString',
  ])('rejects %s as a network name', (name) => {
    expect(isForgeNetworkName(name)).toBe(false);
  });
});
