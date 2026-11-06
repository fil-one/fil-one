import { describe, expect, it } from 'vitest';

import type { S3ObjectVersion } from '@filone/shared';

import {
  getVersionState,
  hasReadableLatestAfterDeleting,
  restoreNullVersionIds,
} from './object-versions.js';

function version(overrides: Partial<S3ObjectVersion>): S3ObjectVersion {
  return {
    key: 'any-key',
    versionId: 'any-version',
    sizeBytes: 1,
    lastModified: '2026-01-01T00:00:00Z',
    isLatest: false,
    isDeleteMarker: false,
    ...overrides,
  };
}

const latest = version({ versionId: 'v-latest', isLatest: true });
const older = version({ versionId: 'v-older' });

describe('getVersionState', () => {
  it('shows the latest version when the URL names none', () => {
    expect(getVersionState([latest, older])).toStrictEqual({
      shownVersionId: 'v-latest',
      shown: latest,
      latest,
      isOlder: false,
      isDeleted: false,
      isVersioned: true,
    });
  });

  it('marks a version other than the latest as older', () => {
    expect(getVersionState([latest, older], 'v-older')).toMatchObject({
      shown: older,
      isOlder: true,
    });
  });

  it('does not mark the latest version as older when the URL names it', () => {
    expect(getVersionState([latest, older], 'v-latest')).toMatchObject({ isOlder: false });
  });

  it('reports a deleted object when its newest entry is a delete marker', () => {
    const marker = version({ versionId: 'v-marker', isLatest: true, isDeleteMarker: true });
    expect(getVersionState([marker, older], 'v-older')).toMatchObject({
      isOlder: true,
      isDeleted: true,
    });
  });

  it('gives no version ID for an object in a bucket without versioning', () => {
    // S3 reports the ID "null" for every object in a bucket that never had versioning
    const unversioned = version({ versionId: 'null', isLatest: true });
    expect(getVersionState([unversioned])).toMatchObject({
      shownVersionId: undefined,
      isVersioned: false,
    });
  });

  it('keeps the version from the URL before the history has loaded', () => {
    expect(getVersionState([], 'v-older')).toMatchObject({
      shownVersionId: 'v-older',
      shown: undefined,
      isOlder: false,
    });
  });
});

describe('restoreNullVersionIds', () => {
  it('gives an entry without an ID the S3 ID "null"', () => {
    // The listing parser reads S3's "null" ID as no ID
    const nullVersion = version({ versionId: '' });
    expect(restoreNullVersionIds([latest, nullVersion])).toStrictEqual([
      latest,
      { ...nullVersion, versionId: 'null' },
    ]);
  });
});

describe('hasReadableLatestAfterDeleting', () => {
  const marker = version({ versionId: 'v-marker', isLatest: true, isDeleteMarker: true });

  it('reports the object readable when a version is newest after the delete', () => {
    expect(hasReadableLatestAfterDeleting([latest, older], 'v-older')).toBe(true);
  });

  it('reports the object readable when deleting the latest leaves an older version on top', () => {
    expect(hasReadableLatestAfterDeleting([latest, older], 'v-latest')).toBe(true);
  });

  it('reports the object unreadable when a delete marker is newest after the delete', () => {
    expect(hasReadableLatestAfterDeleting([marker, older], 'v-older')).toBe(false);
  });

  it('reports the object unreadable when deleting the latest leaves a delete marker on top', () => {
    const olderMarker = version({ versionId: 'v-older-marker', isDeleteMarker: true });
    expect(hasReadableLatestAfterDeleting([latest, olderMarker, older], 'v-latest')).toBe(false);
  });

  it('reports the object unreadable when the deleted version was the only entry', () => {
    expect(hasReadableLatestAfterDeleting([latest], 'v-latest')).toBe(false);
  });
});
