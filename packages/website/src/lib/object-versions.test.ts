import { describe, expect, it } from 'vitest';

import type { S3ObjectVersion } from '@filone/shared';

import type { ListingCursor, ObjectListingPage } from './object-listing.js';
import {
  getDeleteCopy,
  getMissingReason,
  getVersionState,
  getVersionsFromListingPage,
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

  it('counts the version the URL names as older while the history is unknown', () => {
    // The history links its latest row to the object's own URL, so a URL with
    // a version names an older one.
    expect(getVersionState(undefined, 'v-older')).toMatchObject({
      shownVersionId: 'v-older',
      shown: undefined,
      isOlder: true,
    });
  });

  it('does not count the object as older when the URL names no version and the history is unknown', () => {
    expect(getVersionState(undefined)).toMatchObject({ isOlder: false });
  });

  it('does not count a version the loaded history lacks as older', () => {
    expect(getVersionState([], 'v-older')).toMatchObject({ isOlder: false });
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
  const olderMarker = version({ versionId: 'v-older-marker', isDeleteMarker: true });

  it.each([
    ['readable when a version is newest after the delete', [latest, older], 'v-older', true],
    [
      'readable when deleting the latest leaves an older version on top',
      [latest, older],
      'v-latest',
      true,
    ],
    [
      'unreadable when a delete marker is newest after the delete',
      [marker, older],
      'v-older',
      false,
    ],
    [
      'unreadable when deleting the latest leaves a delete marker on top',
      [latest, olderMarker, older],
      'v-latest',
      false,
    ],
    ['unreadable when the deleted version was the only entry', [latest], 'v-latest', false],
  ])('reports the object %s', (_case, versions, deletedVersionId, expected) => {
    expect(hasReadableLatestAfterDeleting(versions, deletedVersionId)).toBe(expected);
  });
});

describe('getMissingReason', () => {
  const marker = version({ versionId: 'v-marker', isLatest: true, isDeleteMarker: true });
  const olderMarker = version({ versionId: 'v-older-marker', isDeleteMarker: true });

  it.each([
    ['deleted when the newest entry is a delete marker', [marker, older], undefined, 'deleted'],
    [
      'a delete marker when the URL names one',
      [latest, olderMarker],
      'v-older-marker',
      'delete-marker',
    ],
    ['not found when the history is empty', [], undefined, 'not-found'],
    ['not found when the URL names a version the history lacks', [latest], 'v-gone', 'not-found'],
    ['nothing missing when the latest is a version', [latest, older], undefined, undefined],
    ['nothing missing when the URL names a version', [latest, older], 'v-older', undefined],
    ['nothing missing while the history is unknown', undefined, undefined, undefined],
  ])('reports %s', (_case, versions, versionId, expected) => {
    expect(getMissingReason(versions, versionId)).toBe(expected);
  });
});

describe('getDeleteCopy', () => {
  // S3's ID for a version written while versioning was never on, or suspended
  const nullLatest = version({ versionId: 'null', isLatest: true });

  it('says a version named in the URL is deleted for good', () => {
    expect(getDeleteCopy({ versionId: 'any-version', isVersioned: true })).toMatchObject({
      title: 'Delete version',
      description:
        'This version will be permanently deleted. Other versions of the object stay in its history.',
    });
  });

  it.each([
    ['versioning is on', { isVersioned: true }],
    // Suspended: a real version ID can only come from when versioning was on.
    [
      'versioning is suspended and the current version has a real ID',
      { isVersioned: false, versions: [latest, older] },
    ],
  ])('says the object is hidden behind a delete marker when %s', (_case, input) => {
    expect(getDeleteCopy(input)).toMatchObject({
      title: 'Delete object',
      description:
        'The object will be hidden behind a delete marker. Its earlier versions stay in its history.',
    });
  });

  it('says only the current version is deleted for good when versioning is suspended and it has the ID "null"', () => {
    expect(getDeleteCopy({ isVersioned: false, versions: [nullLatest, older] })).toMatchObject({
      description:
        'The current version will be permanently deleted and replaced by a delete marker. Its earlier versions stay in its history.',
    });
  });

  it('says the object is deleted for good when versioning was never on', () => {
    expect(getDeleteCopy({ isVersioned: false, versions: [nullLatest] })).toMatchObject({
      description: 'This object will be permanently deleted. This action cannot be undone.',
    });
  });

  it.each([
    ['the bucket settings are unknown', { versions: [nullLatest] }],
    // Versioning off, but whether it was ever on needs the history.
    ['the history is unknown', { isVersioned: false }],
  ])('claims neither outcome when %s', (_case, input) => {
    expect(getDeleteCopy(input)).toMatchObject({
      description:
        'If the bucket keeps versions, the object will be hidden behind a delete marker and its earlier versions stay in its history. If not, it will be permanently deleted.',
    });
  });
});

describe('getVersionsFromListingPage', () => {
  const pageOf = (versions: S3ObjectVersion[], nextCursor?: ListingCursor): ObjectListingPage => ({
    versions,
    folders: [],
    ...(nextCursor && { nextCursor }),
  });

  it("returns the key's entries from a page that holds its whole history", () => {
    const otherKey = version({ key: 'any-other-key' });
    expect(getVersionsFromListingPage(pageOf([latest, otherKey, older]), 'any-key')).toStrictEqual([
      latest,
      older,
    ]);
  });

  it('returns the history from a page that stops after the key', () => {
    const cursor = { kind: 'version', keyMarker: 'any-key' } as const;
    expect(getVersionsFromListingPage(pageOf([latest, older], cursor), 'any-key')).toStrictEqual([
      latest,
      older,
    ]);
  });

  it.each([
    // ListObjectsV2 lists the live object alone, with no version ID.
    ['a page from ListObjectsV2', pageOf([version({ versionId: '', isLatest: true })])],
    // Resumes where the previous page stopped, after the key's latest.
    ['a page that resumes partway through the key', pageOf([older])],
    // The next page resumes after this version of the same key.
    [
      'a page that stops partway through the key',
      pageOf([latest], { kind: 'version', keyMarker: 'any-key', versionIdMarker: 'v-latest' }),
    ],
    ['a page without the key', pageOf([version({ key: 'any-other-key', isLatest: true })])],
    ['no cached page', undefined],
  ])('returns nothing from %s', (_case, page) => {
    expect(getVersionsFromListingPage(page, 'any-key')).toBeUndefined();
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
