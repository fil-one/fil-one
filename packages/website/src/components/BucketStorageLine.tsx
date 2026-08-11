import { useQuery } from '@tanstack/react-query';

import type { BucketAnalyticsResponse, S3Region } from '@filone/shared';
import { formatBytes } from '@filone/shared';

import { apiRequest } from '../lib/api.js';
import { queryKeys } from '../lib/query-client.js';

const FIVE_MINUTES = 5 * 60 * 1000;

/**
 * Size and object count for one bucket, as the secondary line under its name.
 * Reads as metadata about the bucket rather than a column you compare across
 * rows, which is the honest framing: these numbers arrive per row and aren't
 * sortable.
 *
 * Fetched per row rather than folded into `/buckets`: analytics is a separate
 * per-bucket metrics query, so loading it inline would hold the whole table
 * behind the slowest bucket. Each row resolves on its own, shares the query key
 * with the bucket detail page (so navigating there is warm), and holds for five
 * minutes since storage totals move slowly.
 */
export function BucketStorageLine({
  bucketName,
  region,
}: {
  bucketName: string;
  region: S3Region;
}) {
  const { data, isPending, isError } = useQuery({
    queryKey: queryKeys.bucketAnalytics(bucketName, region),
    queryFn: () => {
      const params = new URLSearchParams({ region });
      return apiRequest<BucketAnalyticsResponse>(
        `/buckets/${encodeURIComponent(bucketName)}/analytics?${params.toString()}`,
      );
    },
    staleTime: FIVE_MINUTES,
  });

  // The line keeps its height in every state so rows don't reflow as numbers land.
  if (isPending) {
    return (
      <span
        className="mt-0.5 block h-3 w-28 animate-pulse rounded bg-zinc-100"
        aria-label={`Loading storage for ${bucketName}`}
      />
    );
  }

  // A failed metrics read is not an empty bucket, so say nothing rather than
  // claim "0 B". Nothing at all, not a reserved blank line, which would read as
  // a gap under the name.
  if (isError || !data) return null;

  return (
    <span className="mt-0.5 block text-xs text-zinc-500 tabular-nums">
      {formatBytes(data.bytesUsed)} · {data.objectCount.toLocaleString()}{' '}
      {data.objectCount === 1 ? 'object' : 'objects'}
    </span>
  );
}
