import { describe, it, expect } from 'vitest';

import type { S3ObjectVersion } from '@filone/shared';

import { countObjects } from './ObjectBrowser.js';

function version(
  overrides: Partial<S3ObjectVersion> & Pick<S3ObjectVersion, 'key'>,
): S3ObjectVersion {
  return {
    versionId: '',
    isLatest: true,
    isDeleteMarker: false,
    sizeBytes: 1,
    lastModified: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('countObjects', () => {
  it('counts distinct object keys', () => {
    const versions = [version({ key: 'a.txt' }), version({ key: 'b.txt' })];
    expect(countObjects(versions)).toBe(2);
  });

  it('counts a key whose current version is a delete marker', () => {
    const versions = [
      version({ key: 'live.txt' }),
      // deleted object: older real version + a delete marker that is now latest
      version({
        key: 'deleted.txt',
        versionId: 'v1',
        isLatest: false,
        lastModified: '2026-01-01T00:00:00.000Z',
      }),
      version({
        key: 'deleted.txt',
        versionId: 'v2',
        isLatest: true,
        isDeleteMarker: true,
        sizeBytes: 0,
        lastModified: '2026-01-02T00:00:00.000Z',
      }),
    ];
    expect(countObjects(versions)).toBe(2);
  });

  it('counts a key with multiple versions once', () => {
    const versions = [
      version({ key: 'obj.txt', versionId: 'v1', isLatest: false }),
      version({ key: 'obj.txt', versionId: 'v2', isLatest: true }),
    ];
    expect(countObjects(versions)).toBe(1);
  });

  it('returns 0 for an empty list', () => {
    expect(countObjects([])).toBe(0);
  });
});
