import { describe, expect, it } from 'vitest';

import type { S3ObjectVersion } from '@filone/shared';

import {
  getVersionState,
  getVersionsFromListing,
  hasReadableLatestAfterDeleting,
  removeVersion,
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
    expect(getVersionState([unversioned])).toMatchObject({ shownVersionId: undefined });
  });

  it('gives no version ID when the URL names the "null" version', () => {
    // An object uploaded before versioning was turned on keeps the ID "null"
    const nullVersion = version({ versionId: 'null' });
    expect(getVersionState([latest, nullVersion], 'null')).toMatchObject({
      shownVersionId: undefined,
      shown: nullVersion,
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

describe('getVersionsFromListing', () => {
  const listingOf = (versions: S3ObjectVersion[], isTruncated = false) => ({
    versions,
    isTruncated,
  });

  it("returns the key's entries from a complete listing", () => {
    const otherKey = version({ key: 'any-other-key' });
    expect(getVersionsFromListing(listingOf([latest, otherKey, older]), 'any-key')).toStrictEqual([
      latest,
      older,
    ]);
  });

  it('returns nothing from a truncated listing, which may hold only some versions', () => {
    expect(getVersionsFromListing(listingOf([latest], true), 'any-key')).toBeUndefined();
  });

  it('returns nothing when the listing does not hold the key', () => {
    const otherKey = version({ key: 'any-other-key' });
    expect(getVersionsFromListing(listingOf([otherKey]), 'any-key')).toBeUndefined();
  });

  it('returns nothing when there is no cached listing', () => {
    expect(getVersionsFromListing(undefined, 'any-key')).toBeUndefined();
  });
});

describe('removeVersion', () => {
  it('makes the newest entry left the latest when the latest is deleted', () => {
    expect(removeVersion([latest, older], 'v-latest')).toStrictEqual([
      { ...older, isLatest: true },
    ]);
  });

  it('leaves the latest as it is when an older version is deleted', () => {
    const oldest = version({ versionId: 'v-oldest' });
    expect(removeVersion([latest, older, oldest], 'v-older')).toStrictEqual([latest, oldest]);
  });

  it('returns no entries when the only version is deleted', () => {
    expect(removeVersion([latest], 'v-latest')).toStrictEqual([]);
  });
});
