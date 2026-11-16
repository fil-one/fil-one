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
import { Button } from './Button';
import {
  BUCKET_TABLE_CONTROLS_MIN,
  DEFAULT_BUCKET_SORT,
  EMPTY_BUCKET_FILTERS,
  bucketRegions,
  shouldShowBucketControls,
  type BucketFilters,
  type BucketSort,
} from '../lib/bucket-table.js';
import {
  addFreezePolicy,
  resetPrototype,
  setColdRecord,
  useHasColdBuckets,
  useStorageFilteredBuckets,
  type StorageFilter,
} from '../lib/cold-storage-prototype.js';
import { EMPTY_COLD_RECORD } from '../lib/cold-storage-files.js';

/** A freeze policy old enough that its first daily run has passed. */
function freezeLongAgo(bucketName: string, region: S3Region, prefix = '') {
  setColdRecord(bucketName, region, {
    ...EMPTY_COLD_RECORD,
    policies: [{ prefix, createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000 }],
  });
}

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
  const [storage, setStorage] = useState<StorageFilter>('all');
  const hasColdBuckets = useHasColdBuckets(buckets);
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

  const shown = useStorageFilteredBuckets(visible, storage);

  return (
    <BucketsTable
      buckets={shown}
      onDelete={() => {}}
      showControls={showControls}
      filters={filters}
      onFiltersChange={setFilters}
      sort={sort}
      onSortChange={setSort}
      regions={regions}
      matchCount={shown.length}
      totalCount={buckets.length}
      coldStorage={{
        onFreeze: () => {},
        onRestoreAll: () => {},
        storageFilter: hasColdBuckets ? { value: storage, onChange: setStorage } : undefined,
      }}
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

/**
 * Cold storage prototype (FIL-1608): one bucket frozen as a whole, one with a
 * frozen folder, the rest standard, so the frozen treatment reads against its
 * neighbours.
 */
export const WithColdStorage: Story = {
  args: { buckets: FEW },
  render: function Render(args) {
    useState(() => {
      resetPrototype();
      const [frozen, partly] = [FEW[2], FEW[1]];
      freezeLongAgo(frozen.bucketName, S3Region.EuWest1);
      freezeLongAgo(partly.bucketName, S3Region.EuWest1, '2025/');
    });
    return <InteractiveBucketsTable {...args} />;
  },
};

/**
 * The freeze moment: Freeze schedules the bucket, and at the next daily run
 * (every 10 seconds with short waits) the frost sweeps across the row and the
 * Frozen pill pops in. Reset to try again.
 */
export const FreezeAnimation: Story = {
  args: { buckets: FEW },
  render: function Render(args) {
    useState(() => {
      resetPrototype();
    });
    return (
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => addFreezePolicy(FEW[2].bucketName, S3Region.EuWest1, '')}
          >
            Freeze
          </Button>
          <Button variant="ghost" size="sm" onClick={() => resetPrototype()}>
            Reset
          </Button>
        </div>
        <InteractiveBucketsTable {...args} />
      </div>
    );
  },
};

/**
 * A long list with buckets in cold storage, so the toolbar adds its storage
 * filter beside the region one.
 */
export const WithStorageFilter: Story = {
  args: { buckets: MANY },
  render: function Render(args) {
    useState(() => {
      resetPrototype();
      for (const b of MANY.filter((b) => ['archive-2025', 'legal-hold'].includes(b.bucketName))) {
        freezeLongAgo(b.bucketName, (b.region ?? S3Region.EuWest1) as S3Region);
      }
    });
    return <InteractiveBucketsTable {...args} />;
  },
};
