import { useQuery } from '@tanstack/react-query';

import type { ListObjectVersionsResponse, S3ObjectVersion, S3Region } from '@filone/shared';

import { executePresignedUrl, parseListObjectVersionsResponse } from './aurora-s3.js';
import { LIST_GC_TIME, LIST_STALE_TIME, queryClient, queryKeys } from './query-client.js';
import { batchPresign } from './use-presign.js';

// S3's version ID for every object in a bucket that has never had versioning on
const UNVERSIONED_ID = 'null';

/** Where the version on screen sits in the object's history. */
export type VersionState = {
  /**
   * The ID of the version on screen, for the Details card: the one in the URL,
   * or the latest's when the bucket keeps versions.
   */
  shownVersionId?: string;
  /** The version on screen, once the history has loaded. */
  shown?: S3ObjectVersion;
  /** The newest entry: the latest version, or the delete marker that removed the object. */
  latest?: S3ObjectVersion;
  /** True when the URL names a version that is not the latest. */
  isOlder: boolean;
  /** True when the newest entry is a delete marker: there is no latest to go back to. */
  isDeleted: boolean;
  /** True when the bucket keeps versions, which decides what Delete does. */
  isVersioned: boolean;
};

/**
 * Works out what the page is showing from the object's history and the version
 * in the URL. A URL without a version is the object itself: its latest version.
 */
export function getVersionState(versions: S3ObjectVersion[], versionId?: string): VersionState {
  const latest = versions.find((v) => v.isLatest);
  const isVersioned = versions.some((v) => v.versionId && v.versionId !== UNVERSIONED_ID);
  const isDeleted = latest?.isDeleteMarker ?? false;
  const shown = versionId
    ? versions.find((v) => v.versionId === versionId)
    : isDeleted
      ? undefined
      : latest;
  return {
    shownVersionId: versionId ?? (isVersioned ? shown?.versionId : undefined),
    shown,
    latest,
    isOlder: Boolean(versionId && latest && latest.versionId !== versionId),
    isDeleted,
    isVersioned,
  };
}

/** This key's entries from the bucket page's listing, when the user came from there. */
function getCachedVersions(
  bucketName: string,
  region: S3Region,
  objectKey: string,
): S3ObjectVersion[] | undefined {
  const listing = queryClient.getQueryData<ListObjectVersionsResponse>(
    queryKeys.objects(bucketName, region),
  );
  return listing?.versions.filter((v) => v.key === objectKey);
}

/**
 * The object's version history, newest first. Fetched for this key alone, so it
 * is there on a shared link or a reload, and seeded from the bucket listing when
 * the user came from it so the card does not flash in. The listing is by prefix,
 * which also matches longer keys (`a.png.bak` for `a.png`), so it is filtered to
 * the exact key.
 */
export function useObjectVersions(bucketName: string, region: S3Region, objectKey: string) {
  return useQuery({
    queryKey: queryKeys.objectVersions(bucketName, region, objectKey),
    staleTime: LIST_STALE_TIME,
    gcTime: LIST_GC_TIME,
    initialData: () => getCachedVersions(bucketName, region, objectKey),
    initialDataUpdatedAt: () =>
      queryClient.getQueryState(queryKeys.objects(bucketName, region))?.dataUpdatedAt,
    queryFn: async () => {
      const { items } = await batchPresign(region, [
        { op: 'listObjectVersions', bucket: bucketName, prefix: objectKey },
      ]);
      const response = await executePresignedUrl(items[0].url, items[0].method);
      const { versions } = parseListObjectVersionsResponse(await response.text());
      return versions.filter((v) => v.key === objectKey);
    },
  });
}
