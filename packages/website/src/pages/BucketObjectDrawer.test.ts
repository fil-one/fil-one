import { describe, it, expect } from 'vitest';

import type { S3ObjectVersion } from '@filone/shared';

import { toOpenObject } from './BucketObjectDrawer';

function version(overrides: Partial<S3ObjectVersion>): S3ObjectVersion {
  return {
    key: 'any-key',
    versionId: 'any-version',
    sizeBytes: 1,
    lastModified: '2026-10-21T14:32:00Z',
    isLatest: false,
    isDeleteMarker: false,
    ...overrides,
  };
}

const versions = [
  version({ versionId: 'latest-version', isLatest: true }),
  version({ versionId: 'older-version' }),
];

describe('toOpenObject', () => {
  it.each([
    // A bucket without versioning lists every row with an empty ID
    ['the empty ID of an unversioned bucket', ''],
    ["the latest version's own ID", 'latest-version'],
  ])('opens the object itself for %s', (_case, versionId) => {
    expect(toOpenObject(versions, 'any-key', versionId)).toStrictEqual({ key: 'any-key' });
  });

  it('opens an older version by its ID', () => {
    expect(toOpenObject(versions, 'any-key', 'older-version')).toStrictEqual({
      key: 'any-key',
      versionId: 'older-version',
    });
  });
});
