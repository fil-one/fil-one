// Portable bulk deletion over the S3 data plane.
//
// Every region Fil One serves is a different backend (Aurora, FTH, Forge) but
// all three expose an S3-compatible endpoint, so this module deliberately talks
// only S3 and holds no vendor knowledge. Batched DeleteObjects is used where the
// gateway implements it and per-object DeleteObject otherwise, which is detected
// at runtime rather than configured per region.

import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { BulkDeleteScope, type BulkDeleteFailure } from '@filone/shared';

/** S3 caps DeleteObjects at 1000 keys per request. */
const MULTI_DELETE_BATCH_SIZE = 1000;

/** Parallel DeleteObject calls on the fallback path. */
const FALLBACK_CONCURRENCY = 32;

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
  const { s3, bucket, prefix, cursor, maxKeys } = options;

  const result = await s3.send(
    new ListObjectVersionsCommand({
      Bucket: bucket,
      ...(prefix && { Prefix: prefix }),
      ...(maxKeys && { MaxKeys: maxKeys }),
      ...(cursor?.keyMarker && { KeyMarker: cursor.keyMarker }),
      ...(cursor?.versionIdMarker && { VersionIdMarker: cursor.versionIdMarker }),
    }),
  );

  const targets: BulkDeleteTarget[] = [...(result.Versions ?? []), ...(result.DeleteMarkers ?? [])]
    .filter((item) => item.Key !== undefined)
    .map((item) => ({
      key: item.Key!,
      // A non-versioned (or versioning-suspended) bucket reports every object as
      // the literal "null" version. Deleting by that id is a version-scoped
      // delete (s3:DeleteObjectVersion), which such a bucket neither needs nor
      // reliably permits, so it comes back AccessDenied. Drop it and issue a
      // plain object delete instead.
      ...(item.VersionId && item.VersionId !== 'null' && { versionId: item.VersionId }),
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
  /**
   * True when the gateway rejected batched DeleteObjects outright. The caller
   * should stop attempting it for the rest of the job; this page already
   * completed via the per-object fallback.
   */
  multiDeleteUnsupported: boolean;
}

export interface DeleteTargetsOptions {
  s3: S3Client;
  bucket: string;
  targets: BulkDeleteTarget[];
  /** Set false once a gateway has been seen to reject DeleteObjects. */
  multiDelete?: boolean;
  concurrency?: number;
}

/**
 * Delete a page of targets, returning per-key failures rather than throwing.
 *
 * Object-lock retention makes individual failures normal, not exceptional: a
 * locked object refuses deletion while everything around it succeeds. Aborting
 * the run on the first one would strand the rest, so failures are collected and
 * reported.
 */
export async function deleteTargets(options: DeleteTargetsOptions): Promise<DeleteTargetsResult> {
  const { s3, bucket, targets, multiDelete = true, concurrency = FALLBACK_CONCURRENCY } = options;

  if (targets.length === 0) {
    return { deleted: 0, failures: [], multiDeleteUnsupported: false };
  }

  if (multiDelete) {
    try {
      return await deleteViaMultiDelete(s3, bucket, targets);
    } catch (err) {
      if (!isUnsupportedOperationError(err)) throw err;
      // Gateway does not implement DeleteObjects. Fall through to per-object
      // deletes and tell the caller so the rest of the job skips the attempt.
      const result = await deleteViaIndividualCalls(s3, bucket, targets, concurrency);
      return { ...result, multiDeleteUnsupported: true };
    }
  }

  return {
    ...(await deleteViaIndividualCalls(s3, bucket, targets, concurrency)),
    multiDeleteUnsupported: false,
  };
}

async function deleteViaMultiDelete(
  s3: S3Client,
  bucket: string,
  targets: BulkDeleteTarget[],
): Promise<DeleteTargetsResult> {
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
        message: error.Message ?? 'Delete failed',
      });
    }
    deleted += batch.length - errors.length;
  }

  return { deleted, failures, multiDeleteUnsupported: false };
}

async function deleteViaIndividualCalls(
  s3: S3Client,
  bucket: string,
  targets: BulkDeleteTarget[],
  concurrency: number,
): Promise<{ deleted: number; failures: BulkDeleteFailure[] }> {
  let deleted = 0;
  const failures: BulkDeleteFailure[] = [];

  await mapWithConcurrency(targets, concurrency, async (target) => {
    try {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: target.key,
          ...(target.versionId && { VersionId: target.versionId }),
        }),
      );
      deleted += 1;
    } catch (err) {
      failures.push({
        key: target.key,
        ...(target.versionId && { versionId: target.versionId }),
        code: errorCode(err),
        message: err instanceof Error ? err.message : 'Delete failed',
      });
    }
  });

  return { deleted, failures };
}

/**
 * Whether an error means "this gateway does not implement DeleteObjects", as
 * opposed to a transient or per-object failure. Only these justify dropping to
 * the slower per-object path.
 */
export function isUnsupportedOperationError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;

  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  if (status === 501 || status === 405) return true;

  const code = errorCode(err);
  return (
    code === 'NotImplemented' || code === 'MethodNotAllowed' || code === 'UnsupportedOperation'
  );
}

function errorCode(err: unknown): string {
  if (typeof err !== 'object' || err === null) return 'Unknown';
  const { name, Code } = err as { name?: string; Code?: string };
  return Code ?? name ?? 'Unknown';
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Run `fn` over every item with a bounded number in flight at once. */
async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}
