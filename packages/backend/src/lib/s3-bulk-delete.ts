// Portable bulk deletion over the S3 data plane.
//
// Every region Fil One serves is a different backend (Aurora, FTH, Forge) but
// all three expose an S3-compatible endpoint, so this module deliberately talks
// only S3 and holds no vendor knowledge. Deletion is always batched through
// DeleteObjects, which every gateway Fil One serves implements (verified across
// FTH, Aurora and Forge).

import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { BulkDeleteScope, type BulkDeleteFailure } from '@filone/shared';
import type { BucketVersioningStatus } from './s3-bucket-operations.js';

/** S3 caps DeleteObjects at 1000 keys per request. */
const MULTI_DELETE_BATCH_SIZE = 1000;

/** A single object, or one specific version of it, queued for deletion. */
export interface BulkDeleteTarget {
  key: string;
  versionId?: string;
}

/**
 * Resume point for the listing walk. Which fields are set depends on the scope:
 * `Current` pages with a continuation token, `AllVersions` with the key and
 * version-id marker pair.
 */
export interface BulkDeleteCursor {
  continuationToken?: string;
  keyMarker?: string;
  versionIdMarker?: string;
}

export interface EnumerateDeletionPageOptions {
  s3: S3Client;
  bucket: string;
  prefix: string;
  scope: BulkDeleteScope;
  cursor?: BulkDeleteCursor;
  maxKeys?: number;
  /**
   * Required for `AllVersions`; irrelevant for `Current`, which never lists by
   * version. Decides whether a literal "null" version id from ListObjectVersions
   * is dropped (a plain delete, for a bucket that never enabled versioning) or
   * kept (an explicit version-scoped delete, for a suspended bucket, where a
   * plain delete would leave the null version behind a new delete marker
   * instead of removing it).
   */
  bucketVersioningStatus?: BucketVersioningStatus;
}

export interface EnumerateDeletionPageResult {
  targets: BulkDeleteTarget[];
  /** Absent once the listing is exhausted. */
  nextCursor?: BulkDeleteCursor;
}

/**
 * Read one page of deletion targets.
 *
 * `AllVersions` lists via ListObjectVersions and includes delete markers, which
 * matters: a bucket whose objects were deleted without their markers is still
 * not empty, and DeleteBucket will keep failing on it.
 */
export function enumerateDeletionPage(
  options: EnumerateDeletionPageOptions,
): Promise<EnumerateDeletionPageResult> {
  return options.scope === BulkDeleteScope.Current
    ? enumerateCurrentPage(options)
    : enumerateAllVersionsPage(options);
}

async function enumerateCurrentPage(
  options: EnumerateDeletionPageOptions,
): Promise<EnumerateDeletionPageResult> {
  const { s3, bucket, prefix, cursor, maxKeys } = options;

  const result = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      ...(prefix && { Prefix: prefix }),
      ...(maxKeys && { MaxKeys: maxKeys }),
      ...(cursor?.continuationToken && { ContinuationToken: cursor.continuationToken }),
    }),
  );

  const targets: BulkDeleteTarget[] = (result.Contents ?? [])
    .filter((item) => item.Key !== undefined)
    .map((item) => ({ key: item.Key! }));

  const nextToken = result.IsTruncated ? result.NextContinuationToken : undefined;

  return {
    targets,
    ...(nextToken && { nextCursor: { continuationToken: nextToken } }),
  };
}

async function enumerateAllVersionsPage(
  options: EnumerateDeletionPageOptions,
): Promise<EnumerateDeletionPageResult> {
  const { s3, bucket, prefix, cursor, maxKeys, bucketVersioningStatus } = options;

  const result = await s3.send(
    new ListObjectVersionsCommand({
      Bucket: bucket,
      ...(prefix && { Prefix: prefix }),
      ...(maxKeys && { MaxKeys: maxKeys }),
      ...(cursor?.keyMarker && { KeyMarker: cursor.keyMarker }),
      ...(cursor?.versionIdMarker && { VersionIdMarker: cursor.versionIdMarker }),
    }),
  );

  // A bucket that never enabled versioning reports every object as the literal
  // "null" version. Deleting by that id is a version-scoped delete
  // (s3:DeleteObjectVersion), which such a bucket neither needs nor reliably
  // permits, so it comes back AccessDenied: drop it and issue a plain object
  // delete instead. A *suspended* bucket also reports "null" versions, but
  // there a plain delete only inserts a new null-version delete marker over the
  // existing one rather than removing it, so the bucket never actually empties;
  // the null version id there must be kept and deleted explicitly.
  const dropNullVersionId = bucketVersioningStatus !== 'Suspended';

  const targets: BulkDeleteTarget[] = [...(result.Versions ?? []), ...(result.DeleteMarkers ?? [])]
    .filter((item) => item.Key !== undefined)
    .map((item) => ({
      key: item.Key!,
      ...(item.VersionId &&
        !(dropNullVersionId && item.VersionId === 'null') && { versionId: item.VersionId }),
    }));

  const nextKeyMarker = result.IsTruncated ? result.NextKeyMarker : undefined;

  return {
    targets,
    ...(nextKeyMarker && {
      nextCursor: buildVersionCursor(nextKeyMarker, result.NextVersionIdMarker),
    }),
  };
}

function buildVersionCursor(keyMarker: string, versionIdMarker?: string): BulkDeleteCursor {
  return { keyMarker, ...(versionIdMarker && { versionIdMarker }) };
}

export interface DeleteTargetsResult {
  deleted: number;
  failures: BulkDeleteFailure[];
}

export interface DeleteTargetsOptions {
  s3: S3Client;
  bucket: string;
  targets: BulkDeleteTarget[];
}

/**
 * Delete a page of targets with batched DeleteObjects, returning per-key
 * failures rather than throwing.
 *
 * Object-lock retention makes individual failures normal, not exceptional: a
 * locked object refuses deletion while everything around it succeeds. Aborting
 * the run on the first one would strand the rest, so failures are collected and
 * reported.
 */
export async function deleteTargets(options: DeleteTargetsOptions): Promise<DeleteTargetsResult> {
  const { s3, bucket, targets } = options;

  let deleted = 0;
  const failures: BulkDeleteFailure[] = [];

  for (const batch of chunk(targets, MULTI_DELETE_BATCH_SIZE)) {
    // Quiet mode asks S3 to return only the errors, so the response stays small
    // on the happy path. Successes are inferred as batch size minus errors, and
    // result.Deleted is deliberately ignored: a gateway that returns Deleted
    // entries anyway (Quiet is a request, not a guarantee everywhere) must not
    // change the count. Errors are always authoritative, so the tally holds
    // regardless of whether a given gateway honors Quiet.
    const result = await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: batch.map((t) => ({
            Key: t.key,
            ...(t.versionId && { VersionId: t.versionId }),
          })),
          Quiet: true,
        },
      }),
    );

    const errors = result.Errors ?? [];
    for (const error of errors) {
      failures.push({
        key: error.Key ?? '(unknown)',
        ...(error.VersionId && { versionId: error.VersionId }),
        code: error.Code ?? 'Unknown',
        // Only carry a message when the gateway actually gave one; a synthesized
        // placeholder would read as a bogus reason in the UI.
        ...(error.Message && { message: error.Message }),
      });
    }
    deleted += batch.length - errors.length;
  }

  return { deleted, failures };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
