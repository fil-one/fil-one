import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { PlusIcon, DatabaseIcon } from '@phosphor-icons/react/dist/ssr';

import { PageLayout } from '../components/PageLayout.js';
import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyStateCard } from '../components/EmptyStateCard';
import { BucketsTable } from '../components/BucketsTable';
import { TableSkeleton, type SkeletonColumn } from '../components/Table/TableSkeleton';

import { useBucketsListing } from '../lib/use-buckets-listing.js';
import { useDeleteBucket } from '../lib/use-delete-bucket.js';
import { DEFAULT_BUCKET_SORT, EMPTY_BUCKET_FILTERS } from '../lib/bucket-table.js';

// Mirrors BucketsTable's columns (labels and breakpoints) so the loading
// placeholder drops the same columns at the same widths as the real table.
const SKELETON_COLUMNS: SkeletonColumn[] = [
  { label: 'Name' },
  { label: 'Region', className: 'hidden sm:table-cell' },
  { label: 'Created', className: 'hidden sm:table-cell' },
  {},
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BucketsPage() {
  const navigate = useNavigate();

  const [filters, setFilters] = useState(EMPTY_BUCKET_FILTERS);
  const [sort, setSort] = useState(DEFAULT_BUCKET_SORT);
  const { buckets, baseBuckets, showControls, regions, isPending, isError, error } =
    useBucketsListing(filters, sort);

  const { pendingBucketName, requestDelete, cancelDelete, confirmDelete } = useDeleteBucket();

  // Shared across every state so navigating to Buckets never blanks the header
  // or takes the Create action away while the list loads.
  const createAction = (
    <Button
      id="buckets-create-button"
      variant="ghost"
      size="sm"
      icon={PlusIcon}
      onClick={() => navigate({ to: '/buckets/create' })}
    >
      Create bucket
    </Button>
  );

  if (isPending) {
    return (
      <PageLayout
        title="Buckets"
        description="Organize and manage your storage containers"
        action={createAction}
      >
        <TableSkeleton columns={SKELETON_COLUMNS} aria-label="Loading buckets" />
      </PageLayout>
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
      action={createAction}
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
          onDelete={requestDelete}
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

      <ConfirmDialog
        open={pendingBucketName !== null}
        onClose={cancelDelete}
        onConfirm={confirmDelete}
        title="Delete bucket"
        description="This bucket will be permanently deleted. The bucket must be empty — delete its objects and object versions first."
        confirmLabel="Delete bucket"
      />
    </PageLayout>
  );
}
