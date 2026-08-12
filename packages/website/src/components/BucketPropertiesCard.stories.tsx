import type { Meta, StoryObj } from '@storybook/react-vite';

import type { Bucket, BucketAnalyticsResponse } from '@filone/shared';
import { S3Region } from '@filone/shared';

import { BucketProperties } from './BucketPropertiesCard';

const bucket: Bucket = {
  bucketName: 'customer-exports',
  region: S3Region.EuWest1,
  createdAt: '2026-04-17T09:24:00Z',
  isPublic: false,
  versioning: true,
  objectLockEnabled: false,
  encrypted: true,
};

const analytics: BucketAnalyticsResponse = { objectCount: 1, bytesUsed: 72_192 };

const meta: Meta<typeof BucketProperties> = {
  title: 'Components/BucketProperties',
  component: BucketProperties,
  parameters: { layout: 'padded' },
  args: { bucket, analytics },
};

export default meta;
type Story = StoryObj<typeof BucketProperties>;

export const Default: Story = {};

/** Object Lock on, with the default retention policy that used to orphan a card. */
export const WithRetention: Story = {
  args: {
    bucket: {
      ...bucket,
      objectLockEnabled: true,
      defaultRetention: 'governance',
      retentionDuration: 15,
      retentionDurationType: 'd',
    },
  },
};

/** Nothing enabled, in the US region. */
export const Minimal: Story = {
  args: {
    bucket: { ...bucket, region: S3Region.UsEast1, versioning: false },
    analytics: { objectCount: 0, bytesUsed: 0 },
  },
};

/** Analytics still in flight: the value is held rather than shown as "0 B". */
export const LoadingStorage: Story = {
  args: { analytics: undefined },
};
