import type {
  BucketDetails,
  GetBucketResponse,
  ListObjectVersionsResponse,
  S3Region,
} from '@filone/shared';
import type { QueryClient } from '@tanstack/react-query';

import { apiRequest } from './api.js';
import {
  executePresignedUrl,
  parseListObjectVersionsResponse,
  parseListObjectsResponse,
} from './aurora-s3.js';
import { LIST_STALE_TIME, queryKeys } from './query-client.js';
import { batchPresign } from './use-presign.js';

// Fetch the object listing via presigned URL. Versioned buckets use
// ListObjectVersions so version history is available inline; non-versioned
// buckets use ListObjectsV2, which only ever returns live objects (never delete
// markers). Both paths are normalized to the ListObjectVersionsResponse shape so
// the cache and invalidation logic stay identical.
export async function fetchObjectListing(
  region: S3Region,
  bucketName: string,
  bucket: BucketDetails | null,
): Promise<ListObjectVersionsResponse> {
  if (bucket?.versioning) {
    const { items } = await batchPresign(region, [
      { op: 'listObjectVersions', bucket: bucketName },
    ]);
    const response = await executePresignedUrl(items[0].url, items[0].method);
    return parseListObjectVersionsResponse(await response.text());
  }

  const { items } = await batchPresign(region, [{ op: 'listObjects', bucket: bucketName }]);
  const response = await executePresignedUrl(items[0].url, items[0].method);
  const { objects, isTruncated } = parseListObjectsResponse(await response.text());
  return {
    versions: objects.map((obj) => ({
      ...obj,
      versionId: '',
      isLatest: true,
      isDeleteMarker: false,
    })),
    isTruncated,
  };
}

/**
 * A bucket's listing from the cache the bucket page fills, fetched with the
 * same queries when it isn't there, so a caller outside that page (the
 * Buckets table's Restore all files) sees exactly what the page would.
 */
export async function getBucketListing(
  queryClient: QueryClient,
  bucketName: string,
  region: S3Region,
): Promise<ListObjectVersionsResponse> {
  const { bucket } = await queryClient.fetchQuery({
    queryKey: queryKeys.bucket(bucketName, region),
    staleTime: LIST_STALE_TIME,
    queryFn: () => {
      const params = new URLSearchParams({ region });
      return apiRequest<GetBucketResponse>(
        `/buckets/${encodeURIComponent(bucketName)}?${params.toString()}`,
      );
    },
  });
  return queryClient.fetchQuery({
    queryKey: queryKeys.objects(bucketName, region),
    staleTime: LIST_STALE_TIME,
    queryFn: () => fetchObjectListing(region, bucketName, bucket),
  });
}
