import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import type { Bucket } from '@filone/shared';
import { S3Region, getRegionLabel } from '@filone/shared';

import { BucketsTable } from './BucketsTable';
import {
  BUCKET_TABLE_CONTROLS_MIN,
  DEFAULT_BUCKET_SORT,
  EMPTY_BUCKET_FILTERS,
  bucketRegions,
  shouldShowBucketControls,
  type BucketFilters,
  type BucketSort,
} from '../lib/bucket-table.js';

function withRouter(Story: () => React.JSX.Element) {
  const rootRoute = createRootRoute({ component: Story });
  const bucketRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/buckets/$bucketName',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([bucketRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return <RouterProvider router={router} />;
}

function bucket(bucketName: string, region: S3Region, createdAt: string): Bucket {
  return { bucketName, region, createdAt, isPublic: false };
}

const FEW: Bucket[] = [
  bucket('app-assets', S3Region.EuWest1, '2026-05-02T09:12:00Z'),
  bucket('customer-exports', S3Region.EuWest1, '2026-04-18T16:40:00Z'),
  bucket('site-backups', S3Region.EuWest1, '2026-02-27T11:05:00Z'),
];

const MANY: Bucket[] = [
  ...FEW,
  bucket('analytics-raw', S3Region.UsEast1, '2026-06-01T08:00:00Z'),
  bucket('archive-2025', S3Region.UsEast1, '2026-01-09T13:20:00Z'),
  bucket('legal-hold', S3Region.EuWest1, '2026-02-02T09:00:00Z'),
  bucket('design-library', S3Region.EuCentral3, '2026-03-14T10:30:00Z'),
  bucket('invoices', S3Region.EuWest1, '2026-05-22T15:45:00Z'),
  bucket('ml-training-set', S3Region.EuCentral3, '2026-06-08T07:15:00Z'),
  bucket('product-images', S3Region.EuWest1, '2026-04-01T12:00:00Z'),
  bucket('support-attachments', S3Region.UsEast1, '2026-05-30T18:25:00Z'),
];

/**
 * Filtering and sorting live on the backend now (FIL-324), so BucketsTable is
 * purely presentational. This wrapper simulates that backend round-trip
 * client-side, only so the story stays interactive.
 */
function InteractiveBucketsTable({ buckets }: { buckets: Bucket[] }) {
  const [filters, setFilters] = useState<BucketFilters>(EMPTY_BUCKET_FILTERS);
  const [sort, setSort] = useState<BucketSort>(DEFAULT_BUCKET_SORT);
  const showControls = shouldShowBucketControls(buckets.length);
  const regions = useMemo(() => bucketRegions(buckets), [buckets]);

  const visible = useMemo(() => {
    const query = filters.query.trim().toLowerCase();
    const filtered = buckets.filter((b) => {
      const matchesQuery = query === '' || b.bucketName.toLowerCase().includes(query);
      const matchesRegion = filters.region === 'all' || (b.region ?? '') === filters.region;
      return matchesQuery && matchesRegion;
    });
    const direction = sort.direction === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort.key === 'createdAt') {
        return direction * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      }
      if (sort.key === 'region') {
        return direction * getRegionLabel(a.region).localeCompare(getRegionLabel(b.region));
      }
      return direction * a.bucketName.localeCompare(b.bucketName);
    });
  }, [buckets, filters, sort]);

  return (
    <BucketsTable
      buckets={visible}
      onDelete={() => {}}
      showControls={showControls}
      filters={filters}
      onFiltersChange={setFilters}
      sort={sort}
      onSortChange={setSort}
      regions={regions}
      matchCount={visible.length}
      totalCount={buckets.length}
    />
  );
}

const meta: Meta<typeof InteractiveBucketsTable> = {
  title: 'Components/BucketsTable',
  component: InteractiveBucketsTable,
  decorators: [(Story) => withRouter(() => <Story />)],
  parameters: { layout: 'padded' },
};

export default meta;
type Story = StoryObj<typeof InteractiveBucketsTable>;

/** Below the minimum: no search, no filters, plain headers. */
export const ShortList: Story = {
  args: { buckets: FEW },
};

/** Exactly at the minimum, where the controls first appear. */
export const AtControlsMinimum: Story = {
  args: { buckets: MANY.slice(0, BUCKET_TABLE_CONTROLS_MIN) },
};

/**
 * Above the threshold: search, sortable headers, and a region filter, the last
 * of which appears only because these buckets span three regions.
 */
export const WithControls: Story = {
  args: { buckets: MANY },
};

/** Same long list confined to one region, so the region filter stays hidden. */
export const SingleRegion: Story = {
  args: { buckets: MANY.map((b) => ({ ...b, region: S3Region.EuWest1 })) },
};
