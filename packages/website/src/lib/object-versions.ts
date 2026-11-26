import { useQuery } from '@tanstack/react-query';

import type { S3ObjectVersion, S3Region } from '@filone/shared';

import { executePresignedUrl, parseListObjectVersionsResponse } from './aurora-s3.js';
import type { ListingCursor, ObjectListingPage } from './object-listing.js';
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

/** The Delete dialog's wording. */
export interface DeleteCopy {
  title: string;
  description: string;
  confirmLabel: string;
}

const DELETE_OBJECT_COPY = { title: 'Delete object', confirmLabel: 'Delete object' };

/**
 * What Delete will do, which depends on what it targets and on the bucket.
 *
 * - A version named in the URL is removed for good and the rest stay.
 * - With versioning on, the object is hidden behind a delete marker.
 * - With versioning off, it depends on whether it was ever on. The bucket's
 *   setting reads off both for a bucket that never had it and for one where it
 *   was suspended, but only a suspended bucket can hold a real version ID. There
 *   S3 adds a delete marker and removes for good only a current version with
 *   the ID "null"; older versions stay.
 * - Until the setting and the history load, or if either fails, the copy claims
 *   neither outcome.
 */
export function getDeleteCopy({
  versionId,
  isVersioned,
  versions,
}: {
  versionId?: string;
  isVersioned?: boolean;
  versions?: S3ObjectVersion[];
}): DeleteCopy {
  if (versionId) {
    return {
      title: 'Delete version',
      description:
        'This version will be permanently deleted. Other versions of the object stay in its history.',
      confirmLabel: 'Delete version',
    };
  }
  const hidesBehindMarker = {
    ...DELETE_OBJECT_COPY,
    description:
      'The object will be hidden behind a delete marker. Its earlier versions stay in its history.',
  };
  if (isVersioned) return hidesBehindMarker;
  if (isVersioned === false && versions) {
    if (versions.every((v) => v.versionId === UNVERSIONED_ID)) {
      return {
        ...DELETE_OBJECT_COPY,
        description: 'This object will be permanently deleted. This action cannot be undone.',
      };
    }
    const latest = versions.find((v) => v.isLatest);
    if (latest?.versionId !== UNVERSIONED_ID) return hidesBehindMarker;
    return {
      ...DELETE_OBJECT_COPY,
      description:
        'The current version will be permanently deleted and replaced by a delete marker. Its earlier versions stay in its history.',
    };
  }
  return {
    ...DELETE_OBJECT_COPY,
    description:
      'If the bucket keeps versions, the object will be hidden behind a delete marker and its earlier versions stay in its history. If not, it will be permanently deleted.',
  };
}

/** Whether a listing page stops partway through this key's versions. */
function isSplitAt(cursor: ListingCursor | undefined, objectKey: string): boolean {
  return (
    cursor?.kind === 'version' &&
    cursor.versionIdMarker !== undefined &&
    cursor.keyMarker === objectKey
  );
}

/**
 * This key's entries from one cached page of the bucket listing, when the page
 * holds its whole history. A partial history would be marked fresh and skip the
 * fetch, so a page stands in only when:
 *
 * - it came from ListObjectVersions: a ListObjectsV2 page carries no version IDs
 *   and leaves out older versions and delete markers;
 * - it starts at the key's newest entry, rather than resuming partway through
 *   the key where the previous page stopped;
 * - it does not stop partway through the key itself.
 *
 * Both parsers read S3's "null" ID as no ID, so an object whose only version
 * predates versioning is not seeded; it has no history card to flash in.
 */
export function getVersionsFromListingPage(
  page: ObjectListingPage | undefined,
  objectKey: string,
): S3ObjectVersion[] | undefined {
  if (!page) return undefined;
  const entries = page.versions.filter((v) => v.key === objectKey);
  if (!entries.some((v) => v.versionId)) return undefined;
  if (!entries.some((v) => v.isLatest)) return undefined;
  if (isSplitAt(page.nextCursor, objectKey)) return undefined;
  return restoreNullVersionIds(entries);
}

/** The first cached listing page holding the key's whole history, and when it was fetched. */
function findSeedInListing(bucketName: string, region: S3Region, objectKey: string) {
  for (const [queryKey, page] of queryClient.getQueriesData<ObjectListingPage>({
    queryKey: queryKeys.objects(bucketName, region),
  })) {
    const versions = getVersionsFromListingPage(page, objectKey);
    if (versions) {
      return { versions, updatedAt: queryClient.getQueryState(queryKey)?.dataUpdatedAt };
    }
  }
  return undefined;
}

/**
 * The object's version history, newest first. Fetched for this key alone, so it
 * is there on a shared link or a reload, and seeded from the bucket listing's
 * cached pages when the user came from it so the card does not flash in. The
 * request lists by prefix, which also matches longer keys (`a.png.bak` for
 * `a.png`), so it is filtered to the exact key.
 */
export function useObjectVersions(bucketName: string, region: S3Region, objectKey: string) {
  return useQuery({
    queryKey: queryKeys.objectVersions(bucketName, region, objectKey),
    staleTime: LIST_STALE_TIME,
    gcTime: LIST_GC_TIME,
    initialData: () => findSeedInListing(bucketName, region, objectKey)?.versions,
    initialDataUpdatedAt: () => findSeedInListing(bucketName, region, objectKey)?.updatedAt,
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
