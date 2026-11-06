import { skipToken, useQuery } from '@tanstack/react-query';

import type {
  GetBucketResponse,
  ListObjectVersionsResponse,
  S3ObjectVersion,
  S3Region,
} from '@filone/shared';

import { queryKeys } from './query-client.js';

/**
 * A bucket's listing and versioning flag as the bucket page last loaded them,
 * for the cold storage prototype's dialogs and the upload page. `skipToken`
 * means this never fetches: opened from the Buckets table before the bucket
 * page, the listing is `undefined` and callers fall back to the whole bucket.
 */
export function useCachedListing(
  bucketName: string,
  region: S3Region,
): { versions: S3ObjectVersion[] | undefined; versioned: boolean } {
  const { data: bucket } = useQuery<GetBucketResponse>({
    queryKey: queryKeys.bucket(bucketName, region),
    queryFn: skipToken,
  });
  const { data: listing } = useQuery<ListObjectVersionsResponse>({
    queryKey: queryKeys.objects(bucketName, region),
    queryFn: skipToken,
  });
  return { versions: listing?.versions, versioned: bucket?.bucket.versioning ?? false };
}

/** Every folder in a listing, shallowest first: `a/`, `a/b/`, and so on. */
export function getFolderPrefixes(versions: S3ObjectVersion[]): string[] {
  const prefixes = new Set<string>();
  for (const { key } of versions) {
    const parts = key.split('/').slice(0, -1);
    parts.forEach((_, i) => prefixes.add(`${parts.slice(0, i + 1).join('/')}/`));
  }
  return [...prefixes].sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
  );
}
