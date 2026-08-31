import { useQuery } from '@tanstack/react-query';

import type { BucketAnalyticsResponse, S3Region } from '@filone/shared';
import { formatBytes } from '@filone/shared';

import { apiRequest } from '../lib/api.js';
import { queryKeys } from '../lib/query-client.js';

const FIVE_MINUTES = 5 * 60 * 1000;

/**
 * Size and object count for one bucket, as inline text for the secondary line
 * under its name. Metadata about the bucket rather than a column you compare
 * across rows, which is the honest framing: these numbers arrive per row and
 * aren't sortable. The caller owns the line, so it can prepend the region on
 * mobile where that column is hidden.
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

  if (isPending) {
    return (
      <>
        <MobileSeparator />
        <span
          className="inline-block h-3 w-24 animate-pulse rounded bg-zinc-100"
          aria-label={`Loading storage for ${bucketName}`}
        />
      </>
    );
  }

  // A failed metrics read is not an empty bucket, so say nothing rather than
  // claim "0 B". The caller's line reserves its height either way, so one
  // failing region doesn't leave a shorter row among taller ones and the number
  // lands in place, without reflow, once the read succeeds.
  if (isError || !data) return null;

  return (
    <>
      <MobileSeparator />
      <span>
        {formatBytes(data.bytesUsed)} · {data.objectCount.toLocaleString()}{' '}
        {data.objectCount === 1 ? 'object' : 'objects'}
      </span>
    </>
  );
}

/**
 * Divides this from the region, which shares the line below `sm`. It lives here,
 * rather than beside the region, so it can't outlive what it separates: a row
 * whose storage read fails would otherwise show a dangling separator.
 */
function MobileSeparator() {
  return (
    <span aria-hidden="true" className="sm:hidden">
      ·
    </span>
  );
}
