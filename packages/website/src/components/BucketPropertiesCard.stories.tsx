import type { Meta, StoryObj } from '@storybook/react-vite';

import type { Bucket } from '@filone/shared';

import { BucketPropertyCards } from './BucketPropertiesCard';

const baseBucket: Bucket = {
  bucketName: 'my-bucket',
  region: 'us-east-1',
  createdAt: '2026-01-15T00:00:00Z',
  isPublic: false,
};

function BucketPropertyCardsWrapper({ bucket }: { bucket: Bucket }) {
  return (
    <div className="grid grid-cols-3 gap-4">
      <BucketPropertyCards bucket={bucket} />
    </div>
  );
}

const meta: Meta<typeof BucketPropertyCardsWrapper> = {
  title: 'Components/BucketPropertiesCard',
  component: BucketPropertyCardsWrapper,
};

export default meta;
type Story = StoryObj<typeof BucketPropertyCardsWrapper>;

export const PlainBucket: Story = {
  args: { bucket: baseBucket },
};

export const VersioningEnabled: Story = {
  args: { bucket: { ...baseBucket, versioning: true } },
};

export const ObjectLockNoRetention: Story = {
  args: { bucket: { ...baseBucket, versioning: true, objectLockEnabled: true } },
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
