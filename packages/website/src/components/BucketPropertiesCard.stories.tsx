import type { Meta, StoryObj } from '@storybook/react-vite';

import type { Bucket } from '@filone/shared';

import { BucketPropertiesCard } from './BucketPropertiesCard';

const baseBucket: Bucket = {
  name: 'my-bucket',
  region: 'us-east-1',
  createdAt: '2026-01-15T00:00:00Z',
  isPublic: false,
};

const meta: Meta<typeof BucketPropertiesCard> = {
  title: 'Components/BucketPropertiesCard',
  component: BucketPropertiesCard,
};

export default meta;
type Story = StoryObj<typeof BucketPropertiesCard>;

export const PlainBucket: Story = {
  args: {
    bucket: baseBucket,
  },
};

export const VersioningEnabled: Story = {
  args: {
    bucket: { ...baseBucket, versioning: true },
  },
};

export const ObjectLockNoRetention: Story = {
  args: {
    bucket: { ...baseBucket, versioning: true, objectLockEnabled: true },
  },
};

export const GovernanceRetentionDays: Story = {
  args: {
    bucket: {
      ...baseBucket,
      versioning: true,
      objectLockEnabled: true,
      defaultRetention: 'governance',
      retentionDuration: 30,
      retentionDurationType: 'd',
    },
  },
};

export const ComplianceRetentionYears: Story = {
  args: {
    bucket: {
      ...baseBucket,
      versioning: true,
      objectLockEnabled: true,
      defaultRetention: 'compliance',
      retentionDuration: 7,
      retentionDurationType: 'y',
    },
  },
};

export const SingleYearRetention: Story = {
  args: {
    bucket: {
      ...baseBucket,
      versioning: true,
      objectLockEnabled: true,
      defaultRetention: 'compliance',
      retentionDuration: 1,
      retentionDurationType: 'y',
    },
  },
};
