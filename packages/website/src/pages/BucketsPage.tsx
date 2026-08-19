import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { PlusIcon, DatabaseIcon } from '@phosphor-icons/react/dist/ssr';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { PageLayout } from '../components/PageLayout.js';
import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { EmptyStateCard } from '../components/EmptyStateCard';
import { BucketsTable } from '../components/BucketsTable';

import type { ListBucketsResponse } from '@filone/shared';
import { apiRequest } from '../lib/api.js';
import { queryKeys } from '../lib/query-client.js';
import { useDebouncedValue } from '../lib/use-debounced-value.js';
import {
  DEFAULT_BUCKET_SORT,
  EMPTY_BUCKET_FILTERS,
  bucketRegions,
  bucketsQueryParams,
  hasRefinements,
  shouldShowBucketControls,
} from '../lib/bucket-table.js';

// Round-tripping every keystroke to the backend would make search feel laggy;
// this is short enough that typing still feels live once results land.
const SEARCH_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BucketsPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [filters, setFilters] = useState(EMPTY_BUCKET_FILTERS);
  const [sort, setSort] = useState(DEFAULT_BUCKET_SORT);
  const debouncedQuery = useDebouncedValue(filters.query, SEARCH_DEBOUNCE_MS);
  const debouncedFilters = { ...filters, query: debouncedQuery };

  // The unfiltered baseline: source of truth for whether the list is long
  // enough to need controls at all, and for which regions the filter offers.
  // Filtering that off a page that's already narrowed would make both
  // disappear as soon as a search or region filter takes effect.
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

  const deleteBucketMutation = useMutation({
    mutationFn: (bucketName: string) =>
      apiRequest(`/buckets/${encodeURIComponent(bucketName)}`, { method: 'DELETE' }),
    onSuccess: (_, bucketName) => {
      // Optimistically remove from cache, then confirm with a background refetch
      queryClient.setQueryData<ListBucketsResponse>(queryKeys.buckets, (old) =>
        old ? { buckets: old.buckets.filter((b) => b.bucketName !== bucketName) } : old,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.buckets });
      void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
      toast.success(`Bucket "${bucketName}" deleted`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to delete bucket');
    },
  });

  if (isPending) {
    return (
      <div className="flex items-center justify-center p-16">
        <Spinner ariaLabel="Loading buckets" size={32} />
      </div>
    );
  }

  if (isError) {
    return (
      <PageLayout title="Buckets" description="Organize and manage your storage containers">
        <Alert variant="red" description={error?.message ?? 'Failed to load buckets'} />
      </PageLayout>
    );
  }

  return (
    <PageLayout
      title="Buckets"
      description="Organize and manage your storage containers"
      action={
        <Button
          id="buckets-create-button"
          variant="ghost"
          size="sm"
          icon={PlusIcon}
          onClick={() => navigate({ to: '/buckets/create' })}
        >
          Create bucket
        </Button>
      }
    >
      {baseBuckets.length === 0 ? (
        <EmptyStateCard
          icon={DatabaseIcon}
          title="No buckets yet"
          description="Create your first bucket to start storing objects"
        >
          <Button
            id="buckets-empty-create-button"
            variant="primary"
            icon={PlusIcon}
            onClick={() => navigate({ to: '/buckets/create' })}
          >
            Create bucket
          </Button>
        </EmptyStateCard>
      ) : (
        <BucketsTable
          buckets={buckets}
          onDelete={(bucketName) => deleteBucketMutation.mutate(bucketName)}
          showControls={showControls}
          filters={filters}
          onFiltersChange={setFilters}
          sort={sort}
          onSortChange={setSort}
          regions={regions}
          matchCount={buckets.length}
          totalCount={baseBuckets.length}
        />
      )}
    </PageLayout>
  );
}
