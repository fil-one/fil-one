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
    ['the empty ID of an unversioned bucket', [version({ versionId: '', isLatest: true })], ''],
    ["the latest version's own ID", versions, 'latest-version'],
  ])('opens the object itself for %s', (_case, listing, versionId) => {
    expect(toOpenObject(listing, 'any-key', versionId)).toStrictEqual({ key: 'any-key' });
  });

  it('opens an older version by its ID', () => {
    expect(toOpenObject(versions, 'any-key', 'older-version')).toStrictEqual({
      key: 'any-key',
      versionId: 'older-version',
    });
  });

  it('opens the version saved before versioning was turned on by S3\'s "null" ID', () => {
    // The listing writes that version's "null" ID as ''
    const withNullVersion = [...versions, version({ versionId: '' })];

    expect(toOpenObject(withNullVersion, 'any-key', '')).toStrictEqual({
      key: 'any-key',
      versionId: 'null',
    });
  });
});
