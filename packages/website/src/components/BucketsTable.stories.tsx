import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import type { Bucket } from '@filone/shared';
import { S3Region } from '@filone/shared';

import { BucketsTable } from './BucketsTable';
import { BUCKET_TABLE_CONTROLS_MIN } from '../lib/bucket-table.js';

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

function bucket(
  bucketName: string,
  region: S3Region,
  createdAt: string,
  versioning = false,
): Bucket {
  return { bucketName, region, createdAt, isPublic: false, versioning };
}

/** Object Lock requires versioning, so locked buckets always carry both. */
function locked(base: Bucket, retention?: { duration: number; durationType: 'd' | 'y' }): Bucket {
  return {
    ...base,
    versioning: true,
    objectLockEnabled: true,
    ...(retention && {
      defaultRetention: 'compliance',
      retentionDuration: retention.duration,
      retentionDurationType: retention.durationType,
    }),
  };
}

const FEW: Bucket[] = [
  bucket('app-assets', S3Region.EuWest1, '2026-05-02T09:12:00Z'),
  bucket('customer-exports', S3Region.EuWest1, '2026-04-18T16:40:00Z', true),
  locked(bucket('site-backups', S3Region.EuWest1, '2026-02-27T11:05:00Z'), {
    duration: 30,
    durationType: 'd',
  }),
];

const MANY: Bucket[] = [
  ...FEW,
  bucket('analytics-raw', S3Region.UsEast1, '2026-06-01T08:00:00Z', true),
  locked(bucket('archive-2025', S3Region.UsEast1, '2026-01-09T13:20:00Z')),
  bucket('design-library', S3Region.EuCentral3, '2026-03-14T10:30:00Z'),
  bucket('invoices', S3Region.EuWest1, '2026-05-22T15:45:00Z', true),
  bucket('ml-training-set', S3Region.EuCentral3, '2026-06-08T07:15:00Z'),
  bucket('product-images', S3Region.EuWest1, '2026-04-01T12:00:00Z'),
  bucket('support-attachments', S3Region.UsEast1, '2026-05-30T18:25:00Z'),
];

const meta: Meta<typeof BucketsTable> = {
  title: 'Components/BucketsTable',
  component: BucketsTable,
  decorators: [(Story) => withRouter(() => <Story />)],
  args: { onDelete: () => {} },
  parameters: { layout: 'padded' },
};

export default meta;
type Story = StoryObj<typeof BucketsTable>;

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
