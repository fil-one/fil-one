import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { PlusIcon, DatabaseIcon } from '@phosphor-icons/react/dist/ssr';

import { listBucketsUnavailableMessage } from '@filone/shared';

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
import { RequirePermission } from '../components/RequirePermission';
import { useHasPermission } from '../lib/use-permissions.js';
import { useOrgSlug } from '../lib/use-org-path.js';

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
  const orgSlug = useOrgSlug();
  const mayCreate = useHasPermission('buckets.create');

  const [filters, setFilters] = useState(EMPTY_BUCKET_FILTERS);
  const [sort, setSort] = useState(DEFAULT_BUCKET_SORT);
  const {
    buckets,
    baseBuckets,
    showControls,
    regions,
    unavailableRegions,
    isPending,
    isError,
    error,
  } = useBucketsListing(filters, sort);
  // "No buckets yet" would be a lie while a region is down. The banner explains the gap.
  const showEmptyState = baseBuckets.length === 0 && unavailableRegions.length === 0;

  const { pendingBucketName, requestDelete, cancelDelete, confirmDelete } = useDeleteBucket();

  // Shared across every state so navigating to Buckets never blanks the header
  // or takes the Create action away while the list loads.
  const createAction = (
    <RequirePermission permission="buckets.create">
      <Button
        id="buckets-create-button"
        variant="ghost"
        size="sm"
        icon={PlusIcon}
        onClick={() => navigate({ to: '/$orgSlug/buckets/create', params: { orgSlug } })}
      >
        Create bucket
      </Button>
    </RequirePermission>
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
      {/* Amber suits a response that succeeded: red is the whole-page failure branch, and
          reusing it would make a partial list look like no list at all. */}
      {unavailableRegions.length > 0 && (
        <div className="mb-4">
          <Alert
            variant="amber"
            title={listBucketsUnavailableMessage(unavailableRegions)}
            description="Buckets in the other regions are listed below."
          />
        </div>
      )}

      {/* The invitation goes with the button — "Create your first bucket" over
          an empty card is a dead end for a role that cannot. */}
      {showEmptyState ? (
        <EmptyStateCard
          icon={DatabaseIcon}
          title="No buckets yet"
          description={
            mayCreate
              ? 'Create your first bucket to start storing objects'
              : 'Buckets in this organization appear here'
          }
        >
          {mayCreate && (
            <Button
              id="buckets-empty-create-button"
              variant="primary"
              icon={PlusIcon}
              onClick={() => navigate({ to: '/$orgSlug/buckets/create', params: { orgSlug } })}
            >
              Create bucket
            </Button>
          )}
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
