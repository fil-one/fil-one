import type { S3ObjectVersion, S3Region } from '@filone/shared';

import {
  executePresignedUrl,
  parseListObjectVersionsResponse,
  parseListObjectsResponse,
} from './aurora-s3.js';
import { batchPresign } from './use-presign.js';

/**
 * Entries per page, which S3 takes as `MaxKeys`. Folders count toward it, and in
 * a versioned bucket so does every version, so a page holds at most this many
 * rows and fewer when objects have history. Small enough to render without
 * virtualizing the table; not so small that versioned pages come out thin.
 */
export const OBJECT_PAGE_SIZE = 100;

/** Where a ListObjectsV2 page resumes: the opaque token the previous page returned. */
export interface ContinuationCursor {
  kind: 'continuation';
  token: string;
}

/**
 * Where a ListObjectVersions page resumes. With a key marker alone S3 starts
 * after every version of that key; with a version id marker too it starts after
 * that one version.
 */
export interface VersionCursor {
  kind: 'version';
  keyMarker: string;
  versionIdMarker?: string;
}

export type ListingCursor = ContinuationCursor | VersionCursor;

/** One page of one folder: its objects, its sub-folders, and where the next page starts. */
export interface ObjectListingPage {
  versions: S3ObjectVersion[];
  /** Sub-folder prefixes directly under the listed prefix, each ending in '/'. */
  folders: string[];
  /** Absent on the folder's last page. */
  nextCursor?: ListingCursor;
}

export interface ObjectListingRequest {
  region: S3Region;
  bucketName: string;
  versioning: boolean;
  prefix: string;
  cursor?: ListingCursor;
}

/**
 * Keep a page from ending partway through one key's versions.
 *
 * ListObjectVersions counts versions toward `MaxKeys`, so a page can stop after
 * some of a key's versions, signalled by a version id marker. That key's row
 * would then show an incomplete history here and appear again on the next page.
 * Dropping it from this page and resuming after the key before it moves the
 * whole key to the next page. A page holding nothing but that one key is kept
 * as it is, since there is no earlier key to resume from.
 */
export function keepLastKeyWhole(page: ObjectListingPage): ObjectListingPage {
  const cursor = page.nextCursor;
  if (cursor?.kind !== 'version' || cursor.versionIdMarker === undefined) return page;

  const splitKey = cursor.keyMarker;
  const whole = page.versions.filter((version) => version.key !== splitKey);
  // Compared by code unit, the order S3 lists keys in. The parser sorts with
  // `localeCompare`, so the last element is not necessarily the last key.
  const lastWholeKey = whole.reduce<string | undefined>(
    (last, version) => (last === undefined || version.key > last ? version.key : last),
    undefined,
  );
  if (lastWholeKey === undefined) return page;

  // Folders sort among the keys, so one that sorts after the last whole key is
  // listed again by the next page; listing it here too would show it twice.
  const folders = page.folders.filter((folder) => folder < lastWholeKey);
  return { versions: whole, folders, nextCursor: { kind: 'version', keyMarker: lastWholeKey } };
}

async function fetchVersionsPage({
  region,
  bucketName,
  prefix,
  cursor,
}: ObjectListingRequest): Promise<ObjectListingPage> {
  const resume = cursor?.kind === 'version' ? cursor : undefined;
  const { items } = await batchPresign(region, [
    {
      op: 'listObjectVersions',
      bucket: bucketName,
      prefix,
      delimiter: '/',
      maxKeys: OBJECT_PAGE_SIZE,
      ...(resume && { keyMarker: resume.keyMarker }),
      ...(resume?.versionIdMarker && { versionIdMarker: resume.versionIdMarker }),
    },
  ]);
  const response = await executePresignedUrl(items[0].url, items[0].method);
  const listing = parseListObjectVersionsResponse(await response.text());
  const nextCursor: VersionCursor | undefined =
    listing.isTruncated && listing.nextKeyMarker
      ? {
          kind: 'version',
          keyMarker: listing.nextKeyMarker,
          ...(listing.nextVersionIdMarker && { versionIdMarker: listing.nextVersionIdMarker }),
        }
      : undefined;
  return keepLastKeyWhole({
    versions: listing.versions,
    folders: listing.commonPrefixes,
    nextCursor,
  });
}

async function fetchObjectsPage({
  region,
  bucketName,
  prefix,
  cursor,
}: ObjectListingRequest): Promise<ObjectListingPage> {
  const token = cursor?.kind === 'continuation' ? cursor.token : undefined;
  const { items } = await batchPresign(region, [
    {
      op: 'listObjects',
      bucket: bucketName,
      prefix,
      delimiter: '/',
      maxKeys: OBJECT_PAGE_SIZE,
      ...(token && { continuationToken: token }),
    },
  ]);
  const response = await executePresignedUrl(items[0].url, items[0].method);
  const listing = parseListObjectsResponse(await response.text());
  return {
    // ListObjectsV2 only ever returns live objects, never delete markers, so each
    // one is its own latest version. The shared shape keeps one browser for both.
    versions: listing.objects.map((object) => ({
      ...object,
      versionId: '',
      isLatest: true,
      isDeleteMarker: false,
    })),
    folders: listing.commonPrefixes,
    ...(listing.isTruncated &&
      listing.nextToken && { nextCursor: { kind: 'continuation', token: listing.nextToken } }),
  };
}

/**
 * Fetch one page of one folder through a presigned URL. A versioned bucket is
 * listed with ListObjectVersions so each row carries its history; any other
 * with ListObjectsV2.
 */
export function fetchObjectListingPage(request: ObjectListingRequest): Promise<ObjectListingPage> {
  return request.versioning ? fetchVersionsPage(request) : fetchObjectsPage(request);
}

/** A cached page with one version removed, after that version was deleted. */
export function removeVersionFromPage(
  page: ObjectListingPage | undefined,
  key: string,
  versionId: string,
): ObjectListingPage | undefined {
  if (!page) return page;
  return {
    ...page,
    versions: page.versions.filter((v) => !(v.key === key && v.versionId === versionId)),
  };
}
