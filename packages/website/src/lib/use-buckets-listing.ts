import { keepPreviousData, useQuery } from '@tanstack/react-query';

import type { ListBucketsResponse } from '@filone/shared';

import { apiRequest } from './api.js';
import { queryKeys } from './query-client.js';
import { useDebouncedValue } from './use-debounced-value.js';
import {
  bucketRegions,
  bucketsQueryParams,
  hasRefinements,
  shouldShowBucketControls,
  type BucketFilters,
  type BucketSort,
} from './bucket-table.js';

// Round-tripping every keystroke to the backend would make search feel laggy;
// this is short enough that typing still feels live once results land.
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Buckets for the page: an always-fetched unfiltered baseline (for the total
 * count and region options) plus a second, debounced query for the active
 * filter/sort, so narrowing a search can't also hide the controls that would
 * undo it.
 */
export function useBucketsListing(filters: BucketFilters, sort: BucketSort) {
  const debouncedQuery = useDebouncedValue(filters.query, SEARCH_DEBOUNCE_MS);
  const debouncedFilters = { ...filters, query: debouncedQuery };

  const {
    data: baseData,
    isPending,
    isError,
    error,
  } = useQuery({
    queryKey: queryKeys.buckets,
    queryFn: () => apiRequest<ListBucketsResponse>('/buckets'),
  });
  const baseBuckets = baseData?.buckets ?? [];
  const showControls = shouldShowBucketControls(baseBuckets.length);
  const regions = bucketRegions(baseBuckets);

  // Only fetched once there's something to refine: a plain, default-sorted
  // view is exactly what the baseline query above already holds.
  const refining = showControls && hasRefinements(debouncedFilters, sort);
  const params = bucketsQueryParams(debouncedFilters, sort);
  const { data: refinedData } = useQuery({
    queryKey: queryKeys.bucketsFiltered(Object.fromEntries(params)),
    queryFn: () => apiRequest<ListBucketsResponse>(`/buckets?${params.toString()}`),
    enabled: refining,
    // Keeps the previous filtered result on screen while a new filter/sort
    // combination loads, rather than flashing the "no matching buckets" empty
    // state for every keystroke or click.
    placeholderData: keepPreviousData,
  });

  // Falls back to the unfiltered baseline while the very first refined result
  // is still in flight, rather than flashing an empty table.
  const buckets = refining ? (refinedData?.buckets ?? baseBuckets) : baseBuckets;

  return { buckets, baseBuckets, showControls, regions, isPending, isError, error };
}
