import { useQuery } from '@tanstack/react-query';

import type {
  GetBucketResponse,
  ObjectMetadataResponse,
  ObjectRetentionInfo,
  S3ObjectVersion,
  S3Region,
} from '@filone/shared';

import { apiRequest } from './api.js';
import {
  executePresignedUrl,
  parseGetObjectRetentionResponse,
  parseHeadObjectResponse,
  S3RequestError,
} from './aurora-s3.js';
import { LIST_GC_TIME, LIST_STALE_TIME, queryClient, queryKeys } from './query-client.js';
import { batchPresign } from './use-presign.js';

/** One object, or one version of it, in one bucket. */
export type ObjectRef = {
  bucketName: string;
  region: S3Region;
  objectKey: string;
  versionId?: string;
};

// Long enough that resting on a row, then opening it, never fetches twice
const OBJECT_METADATA_STALE_TIME = 30_000;

function buildMetadataResponse(
  head: ReturnType<typeof parseHeadObjectResponse>,
  retention?: ObjectRetentionInfo,
): ObjectMetadataResponse {
  return {
    key: head.key,
    sizeBytes: head.sizeBytes,
    lastModified: head.lastModified,
    ...(head.etag && { etag: head.etag }),
    ...(head.contentType && { contentType: head.contentType }),
    metadata: head.metadata,
    ...(retention && { retention }),
  };
}

async function fetchObjectRetention(
  url: string,
  method: string,
): Promise<ObjectRetentionInfo | undefined> {
  try {
    const response = await executePresignedUrl(url, method);
    const xml = await response.text();
    return parseGetObjectRetentionResponse(xml) ?? undefined;
  } catch (err) {
    // Objects without retention configured return an S3 error, which is expected.
    const msg = err instanceof Error ? err.message : '';
    const isExpected =
      msg.includes('NoSuchObjectLockConfiguration') ||
      msg.includes('ObjectLockConfigurationNotFoundError');
    if (!isExpected) {
      console.error('Failed to fetch object retention:', err);
    }
    return undefined;
  }
}

/**
 * The bucket's settings, under the bucket page's own key and cache times, so
 * arriving from there costs nothing. Fetched here too because a shared link or a
 * reload lands on the object page cold, and Object Lock decides whether the object
 * can hold a retention period at all.
 */
export function bucketQueryOptions(bucketName: string, region: S3Region) {
  return {
    queryKey: queryKeys.bucket(bucketName, region),
    staleTime: LIST_STALE_TIME,
    gcTime: LIST_GC_TIME,
    queryFn: () =>
      apiRequest<GetBucketResponse>(
        `/buckets/${encodeURIComponent(bucketName)}?${new URLSearchParams({ region }).toString()}`,
      ),
  };
}

async function isObjectLockEnabled(bucketName: string, region: S3Region): Promise<boolean> {
  try {
    const { bucket } = await queryClient.ensureQueryData(bucketQueryOptions(bucketName, region));
    return bucket.objectLockEnabled ?? false;
  } catch {
    // Without the bucket's settings the object's own details still load; only the
    // retention lookup is skipped
    return false;
  }
}

async function fetchObjectMetadata({
  bucketName,
  region,
  objectKey,
  versionId,
}: ObjectRef): Promise<ObjectMetadataResponse> {
  const hasObjectLock = await isObjectLockEnabled(bucketName, region);
  const target = { bucket: bucketName, key: objectKey, ...(versionId && { versionId }) };
  const ops = [
    { op: 'headObject' as const, ...target },
    ...(hasObjectLock ? [{ op: 'getObjectRetention' as const, ...target }] : []),
  ];
  const { items } = await batchPresign(region, ops);

  const headResponse = await executePresignedUrl(items[0].url, items[0].method);
  const head = parseHeadObjectResponse(headResponse, objectKey);

  const retention =
    hasObjectLock && items[1]
      ? await fetchObjectRetention(items[1].url, items[1].method)
      : undefined;

  return buildMetadataResponse(head, retention);
}

/**
 * The object's HEAD (and retention, when the bucket has Object Lock), under one
 * key for the object page and the bucket page's details panel. Whichever loads
 * it first, the other opens with it already in hand.
 */
export function objectMetadataQueryOptions(ref: ObjectRef) {
  return {
    queryKey: queryKeys.objectMetadata(ref.bucketName, ref.objectKey, ref.versionId),
    staleTime: OBJECT_METADATA_STALE_TIME,
    queryFn: () => fetchObjectMetadata(ref),
  };
}

/** `enabled: false` asks nothing, for a view that already knows S3 has no content to give. */
export function useObjectMetadata(ref: ObjectRef, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ ...objectMetadataQueryOptions(ref), enabled });
}

/**
 * Drops every version's cached details of an object, so a view opened after
 * deleting it asks S3 again. Marking them stale would not do: a view would
 * still show the old details beside the error S3 answers with.
 */
export function removeObjectMetadata(bucketName: string, objectKey: string): void {
  queryClient.removeQueries({ queryKey: queryKeys.objectMetadata(bucketName, objectKey) });
}

/** Starts loading an object's details ahead of a click that is likely to come. */
export function prefetchObjectMetadata(ref: ObjectRef): void {
  void queryClient.prefetchQuery(objectMetadataQueryOptions(ref));
}

/** Whether loading an object's details failed because S3 has no such object or version. */
export function isObjectNotFoundError(error: unknown): boolean {
  return error instanceof S3RequestError && error.status === 404;
}

/**
 * What the bucket listing already says about an object, in the shape of its full
 * details, so a view of it can show these before the HEAD request answers. The
 * rest (type, user metadata, retention) is unknown until then, and is left empty.
 */
export function getListedMetadata(version: S3ObjectVersion): ObjectMetadataResponse {
  return {
    key: version.key,
    sizeBytes: version.sizeBytes,
    lastModified: version.lastModified,
    ...(version.etag && { etag: version.etag }),
    metadata: {},
  };
}

/**
 * Whether a retention setting still holds the object. S3 keeps returning the
 * setting after its date passes, so its presence alone says nothing.
 */
export function isRetentionActive(retention: ObjectRetentionInfo, now = Date.now()): boolean {
  return new Date(retention.retainUntilDate).getTime() > now;
}
