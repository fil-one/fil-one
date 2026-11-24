import { beforeEach, describe, expect, it, vi } from 'vitest';

import { S3Region, type S3ObjectVersion } from '@filone/shared';

const mockBatchPresign = vi.fn();
vi.mock('./use-presign.js', () => ({
  batchPresign: (...args: unknown[]) => mockBatchPresign(...args),
}));

const mockParseVersions = vi.fn();
const mockParseObjects = vi.fn();
vi.mock('./aurora-s3.js', () => ({
  executePresignedUrl: () => Promise.resolve({ text: () => Promise.resolve('<xml/>') }),
  parseListObjectVersionsResponse: () => mockParseVersions(),
  parseListObjectsResponse: () => mockParseObjects(),
}));

import { fetchObjectListingPage, keepLastKeyWhole, OBJECT_PAGE_SIZE } from './object-listing.js';

function version(key: string, versionId: string): S3ObjectVersion {
  return {
    key,
    versionId,
    isLatest: true,
    isDeleteMarker: false,
    sizeBytes: 1,
    lastModified: '2026-01-01T00:00:00.000Z',
  };
}

const request = {
  region: S3Region.EuWest1,
  bucketName: 'any-bucket',
  prefix: 'any-folder/',
};

beforeEach(() => {
  mockBatchPresign.mockResolvedValue({ items: [{ url: 'https://s3.test/list', method: 'GET' }] });
});

describe('keepLastKeyWhole', () => {
  it('moves a key whose versions the page cut short to the next page', () => {
    const page = keepLastKeyWhole({
      versions: [version('a', 'a1'), version('b', 'b1')],
      folders: [],
      nextCursor: { kind: 'version', keyMarker: 'b', versionIdMarker: 'b1' },
    });

    expect(page).toStrictEqual({
      versions: [version('a', 'a1')],
      folders: [],
      nextCursor: { kind: 'version', keyMarker: 'a' },
    });
  });

  it('leaves folders after the last whole key for the next page to list', () => {
    const page = keepLastKeyWhole({
      versions: [version('a', 'a1'), version('c', 'c1')],
      folders: ['0-folder/', 'b-folder/'],
      nextCursor: { kind: 'version', keyMarker: 'c', versionIdMarker: 'c1' },
    });

    expect(page.folders).toStrictEqual(['0-folder/']);
  });

  it('resumes after the last key in S3 order, not in the locale order the parser sorts by', () => {
    // localeCompare puts 'a' before 'B'; S3 lists by code unit, where 'B' comes first.
    const page = keepLastKeyWhole({
      versions: [version('a', 'a1'), version('B', 'B1'), version('c', 'c1')],
      folders: [],
      nextCursor: { kind: 'version', keyMarker: 'c', versionIdMarker: 'c1' },
    });

    expect(page.nextCursor).toStrictEqual({ kind: 'version', keyMarker: 'a' });
  });

  it('keeps a page holding only the cut-short key, which has no earlier key to resume from', () => {
    const page = {
      versions: [version('a', 'a1')],
      folders: [],
      nextCursor: { kind: 'version' as const, keyMarker: 'a', versionIdMarker: 'a1' },
    };

    expect(keepLastKeyWhole(page)).toBe(page);
  });

  it('keeps a page that ended between keys', () => {
    const page = {
      versions: [version('a', 'a1')],
      folders: [],
      nextCursor: { kind: 'version' as const, keyMarker: 'a' },
    };

    expect(keepLastKeyWhole(page)).toBe(page);
  });
});

describe('fetchObjectListingPage', () => {
  it('lists one folder with a delimiter and the page size', async () => {
    mockParseObjects.mockReturnValue({ objects: [], commonPrefixes: [], isTruncated: false });

    await fetchObjectListingPage({ ...request, versioning: false });

    expect(mockBatchPresign).toHaveBeenCalledWith(S3Region.EuWest1, [
      {
        op: 'listObjects',
        bucket: 'any-bucket',
        prefix: 'any-folder/',
        delimiter: '/',
        maxKeys: OBJECT_PAGE_SIZE,
      },
    ]);
  });

  it('resumes an unversioned listing from its continuation token', async () => {
    mockParseObjects.mockReturnValue({ objects: [], commonPrefixes: [], isTruncated: false });

    await fetchObjectListingPage({
      ...request,
      versioning: false,
      cursor: { kind: 'continuation', token: 'any-token' },
    });

    expect(mockBatchPresign).toHaveBeenCalledWith(S3Region.EuWest1, [
      expect.objectContaining({ op: 'listObjects', continuationToken: 'any-token' }),
    ]);
  });

  it('resumes a versioned listing from its key and version markers', async () => {
    mockParseVersions.mockReturnValue({ versions: [], commonPrefixes: [], isTruncated: false });

    await fetchObjectListingPage({
      ...request,
      versioning: true,
      cursor: { kind: 'version', keyMarker: 'any-key', versionIdMarker: 'any-version' },
    });

    expect(mockBatchPresign).toHaveBeenCalledWith(S3Region.EuWest1, [
      expect.objectContaining({
        op: 'listObjectVersions',
        keyMarker: 'any-key',
        versionIdMarker: 'any-version',
      }),
    ]);
  });

  it('returns the folders and the next page of a truncated unversioned listing', async () => {
    mockParseObjects.mockReturnValue({
      objects: [{ key: 'any-folder/a', sizeBytes: 1, lastModified: '2026-01-01T00:00:00.000Z' }],
      commonPrefixes: ['any-folder/sub/'],
      nextToken: 'any-token',
      isTruncated: true,
    });

    await expect(fetchObjectListingPage({ ...request, versioning: false })).resolves.toStrictEqual({
      versions: [
        {
          key: 'any-folder/a',
          sizeBytes: 1,
          lastModified: '2026-01-01T00:00:00.000Z',
          versionId: '',
          isLatest: true,
          isDeleteMarker: false,
        },
      ],
      folders: ['any-folder/sub/'],
      nextCursor: { kind: 'continuation', token: 'any-token' },
    });
  });

  it('returns no next page when the listing is complete', async () => {
    mockParseVersions.mockReturnValue({
      versions: [version('any-folder/a', 'a1')],
      commonPrefixes: [],
      isTruncated: false,
    });

    await expect(fetchObjectListingPage({ ...request, versioning: true })).resolves.toStrictEqual({
      versions: [version('any-folder/a', 'a1')],
      folders: [],
      nextCursor: undefined,
    });
  });
});
