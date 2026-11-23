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
   * or the latest's. Never S3's "null", which names no version a reader can use.
   */
  shownVersionId?: string;
  /** The version on screen, once the history has loaded. */
  shown?: S3ObjectVersion;
  /** The newest entry: the latest version, or the delete marker that removed the object. */
  latest?: S3ObjectVersion;
  /**
   * True when the URL names a version that is not the latest. Until the history
   * is known, any version the URL names counts: the history links its latest
   * row to the object's own URL, so a URL with a version names an older one.
   */
  isOlder: boolean;
  /** True when the newest entry is a delete marker: there is no latest to go back to. */
  isDeleted: boolean;
};

/**
 * Works out what the page is showing from the object's history and the version
 * in the URL. A URL without a version is the object itself: its latest version.
 * `versions` is undefined while the history is loading or after it failed.
 */
export function getVersionState(
  versions: S3ObjectVersion[] | undefined,
  versionId?: string,
): VersionState {
  const latest = versions?.find((v) => v.isLatest);
  const isDeleted = latest?.isDeleteMarker ?? false;
  const shown = versionId
    ? versions?.find((v) => v.versionId === versionId)
    : isDeleted
      ? undefined
      : latest;
  const shownVersionId = versionId ?? shown?.versionId;
  return {
    shownVersionId: shownVersionId === UNVERSIONED_ID ? undefined : shownVersionId,
    shown,
    latest,
    isOlder: Boolean(versionId) && (latest ? latest.versionId !== versionId : !versions),
    isDeleted,
  };
}

/** Why the object or version in the URL has nothing to show; {@link getMissingReason} says when each applies. */
export type MissingReason = 'deleted' | 'delete-marker' | 'not-found';

/**
 * Why the object or version in the URL has nothing to show, judged from its
 * history alone. For a page whose metadata request failed: the status that
 * request gets back differs by provider (a delete marker answers 405 in one
 * region and 404 in another), while the history says the same thing in both.
 * Undefined when the history is unknown, or names a version that should exist.
 *
 * - `deleted`: the URL names no version and the newest entry is a delete marker.
 * - `delete-marker`: the URL names a delete marker, which has no content.
 * - `not-found`: the history holds no entry the URL could mean.
 */
export function getMissingReason(
  versions: S3ObjectVersion[] | undefined,
  versionId?: string,
): MissingReason | undefined {
  if (!versions) return undefined;
  const target = versionId
    ? versions.find((v) => v.versionId === versionId)
    : versions.find((v) => v.isLatest);
  if (!target) return 'not-found';
  if (!target.isDeleteMarker) return undefined;
  return versionId ? 'delete-marker' : 'deleted';
}

/**
 * The history with S3's own ID, "null", put back on the entries that have it.
 * The listing parser reads "null" as no ID, which suits the bucket table, but
 * the oldest version of an object uploaded before versioning was turned on has
 * that ID, and a request needs it to reach that version rather than the latest.
 */
export function restoreNullVersionIds(versions: S3ObjectVersion[]): S3ObjectVersion[] {
  return versions.map((v) => (v.versionId ? v : { ...v, versionId: UNVERSIONED_ID }));
}

/**
 * Whether the object can still be opened once `deletedVersionId` is gone: the
 * newest entry left is a version, not a delete marker. `versions` is newest first.
 */
export function hasReadableLatestAfterDeleting(
  versions: S3ObjectVersion[],
  deletedVersionId: string,
): boolean {
  const newestLeft = versions.find((v) => v.versionId !== deletedVersionId);
  return newestLeft !== undefined && !newestLeft.isDeleteMarker;
}

/**
 * The history without one deleted version, so the page does not show it as
 * "Latest" while the refetch is in flight. When it was the latest, the newest
 * entry left takes its place, as it does in S3.
 */
export function removeVersion(
  versions: S3ObjectVersion[],
  deletedVersionId: string,
): S3ObjectVersion[] {
  const deleted = versions.find((v) => v.versionId === deletedVersionId);
  const left = versions.filter((v) => v.versionId !== deletedVersionId);
  if (!deleted?.isLatest || left.length === 0) return left;
  return [{ ...left[0], isLatest: true }, ...left.slice(1)];
}

/**
 * This key's entries from the bucket page's listing, when the user came from
 * there. Only a complete listing that holds the key can stand in for its
 * history: the listing is a single page, so a truncated one may hold some of
 * the key's versions or none of them, and seeding from it would mark that
 * partial history fresh and skip the fetch.
 */
export function getVersionsFromListing(
  listing: ListObjectVersionsResponse | undefined,
  objectKey: string,
): S3ObjectVersion[] | undefined {
  if (!listing || listing.isTruncated) return undefined;
  const entries = listing.versions.filter((v) => v.key === objectKey);
  return entries.length > 0 ? restoreNullVersionIds(entries) : undefined;
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
    initialData: () =>
      getVersionsFromListing(
        queryClient.getQueryData<ListObjectVersionsResponse>(queryKeys.objects(bucketName, region)),
        objectKey,
      ),
    initialDataUpdatedAt: () =>
      queryClient.getQueryState(queryKeys.objects(bucketName, region))?.dataUpdatedAt,
    queryFn: async () => {
      const { items } = await batchPresign(region, [
        { op: 'listObjectVersions', bucket: bucketName, prefix: objectKey },
      ]);
      const response = await executePresignedUrl(items[0].url, items[0].method);
      const { versions } = parseListObjectVersionsResponse(await response.text());
      return restoreNullVersionIds(versions.filter((v) => v.key === objectKey));
    },
  });
}
