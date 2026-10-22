import { describe, expect, it } from 'vitest';

import {
  findOlderConsoleKeys,
  findPrunableConsoleKey,
  getConsoleKeyName,
  getConsoleKeyVersion,
  getNextConsoleKeyVersion,
} from './console-key-version.ts';

function serviceKey(name: string) {
  return { type: 'service', name, accessKeyId: `id-${name}` };
}

describe('getConsoleKeyVersion', () => {
  it.each([
    ['filone-console', 1],
    ['filone-console-v2', 2],
    ['filone-console-v12', 12],
  ])('reads %s as version %i', (name, version) => {
    expect(getConsoleKeyVersion(name)).toBe(version);
  });

  it.each([
    // Version 1 carries no suffix.
    'filone-console-v1',
    'filone-console-v0',
    // A leading zero would give two names for one version.
    'filone-console-v02',
    'filone-console-v',
    'filone-console-v2-extra',
    'any-key',
  ])('reads %s as no console key version', (name) => {
    expect(getConsoleKeyVersion(name)).toBeUndefined();
  });
});

describe('getConsoleKeyName', () => {
  it.each([
    [1, 'filone-console'],
    [2, 'filone-console-v2'],
    [3, 'filone-console-v3'],
  ])('names version %i %s', (version, name) => {
    expect(getConsoleKeyName(version)).toBe(name);
  });
});

describe('getNextConsoleKeyVersion', () => {
  it.each([
    ['filone-console', 2],
    ['filone-console-v2', 3],
  ])('rotates %s to version %i', (current, next) => {
    expect(getNextConsoleKeyVersion(current)).toBe(next);
  });

  it('rotates a tenant with no console key to version 2', () => {
    expect(getNextConsoleKeyVersion(undefined)).toBe(2);
  });

  it('refuses a console key whose name carries no version', () => {
    expect(() => getNextConsoleKeyVersion('any-key')).toThrow(
      'the console signs with "any-key", which is not a filone-console key name.',
    );
  });
});

describe('findOlderConsoleKeys', () => {
  it('returns the console keys below the version, and no other key', () => {
    const keys = [
      serviceKey('filone-console'),
      serviceKey('filone-console-v2'),
      serviceKey('filone-console-v3'),
      serviceKey('any-key'),
      { type: 'principal', name: 'filone-console', accessKeyId: 'any-principal-key' },
    ];

    expect(findOlderConsoleKeys(keys, 3)).toStrictEqual([
      serviceKey('filone-console'),
      serviceKey('filone-console-v2'),
    ]);
  });
});

describe('findPrunableConsoleKey', () => {
  const keys = [
    serviceKey('filone-console'),
    serviceKey('filone-console-v2'),
    serviceKey('filone-console-v3'),
  ];

  it.each([
    ['filone-console-v2', 'filone-console'],
    ['filone-console-v3', 'filone-console-v2'],
  ])('prunes the key one version below %s, %s', (current, previous) => {
    expect(findPrunableConsoleKey(keys, current)).toStrictEqual(serviceKey(previous));
  });

  it('prunes nothing while the console signs with version 1', () => {
    expect(findPrunableConsoleKey(keys, 'filone-console')).toBeUndefined();
  });

  it('prunes nothing when version N-1 is already gone', () => {
    expect(findPrunableConsoleKey([serviceKey('filone-console-v3')], 'filone-console-v3')).toBe(
      undefined,
    );
  });

  it('prunes no principal key with the previous name', () => {
    const principal = { type: 'principal', name: 'filone-console', accessKeyId: 'any-id' };

    expect(findPrunableConsoleKey([principal], 'filone-console-v2')).toBeUndefined();
  });
});
