import { describe, expect, it } from 'vitest';

import type { S3ObjectVersion } from '@filone/shared';

import { getEntriesAtPrefix, groupVersionsByKey } from './object-grouping.js';

function version(key: string): S3ObjectVersion {
  return {
    key,
    versionId: '',
    isLatest: true,
    isDeleteMarker: false,
    sizeBytes: 1,
    lastModified: '2026-01-01T00:00:00.000Z',
  };
}

describe('getEntriesAtPrefix', () => {
  it('lists the listing’s folders before its objects, each by name', () => {
    const entries = getEntriesAtPrefix(
      groupVersionsByKey([version('any/b.txt'), version('any/a.txt')]),
      ['any/zeta/', 'any/alpha/'],
      'any/',
    );

    expect(entries.map(({ kind, name }) => ({ kind, name }))).toStrictEqual([
      { kind: 'folder', name: 'alpha' },
      { kind: 'folder', name: 'zeta' },
      { kind: 'object', name: 'a.txt' },
      { kind: 'object', name: 'b.txt' },
    ]);
  });

  it('gives the folder’s own zero-byte marker key no row', () => {
    // 'any/' is the listed prefix itself, written by tools that create empty folders.
    const entries = getEntriesAtPrefix(
      groupVersionsByKey([version('any/'), version('any/a.txt')]),
      [],
      'any/',
    );

    expect(entries.map((entry) => entry.name)).toStrictEqual(['a.txt']);
  });

  it('links each folder row to its full prefix', () => {
    const entries = getEntriesAtPrefix([], ['any/sub/'], 'any/');

    expect(entries).toStrictEqual([{ kind: 'folder', name: 'sub', prefix: 'any/sub/' }]);
  });
});
