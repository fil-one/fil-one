import type { Meta, StoryObj } from '@storybook/react-vite';

import { BulkDeleteJobStatus, BulkDeleteScope, S3Region, type BulkDeleteJob } from '@filone/shared';

import { EmptyBucketDialog } from './EmptyBucketDialog';

function job(overrides: Partial<BulkDeleteJob> = {}): BulkDeleteJob {
  return {
    jobId: 'job-1',
    bucketName: 'my-bucket',
    region: S3Region.EuWest1,
    prefix: '',
    scope: BulkDeleteScope.AllVersions,
    status: BulkDeleteJobStatus.Running,
    deletedCount: 0,
    failedCount: 0,
    failures: [],
    startedAt: '2026-04-01T10:00:00Z',
    updatedAt: '2026-04-01T10:00:05Z',
    ...overrides,
  };
}

const meta: Meta<typeof EmptyBucketDialog> = {
  title: 'Components/EmptyBucketDialog',
  component: EmptyBucketDialog,
  args: {
    open: true,
    onClose: () => {},
    onConfirm: () => {},
    bucketName: 'my-bucket',
    totalObjectCount: 20_000,
    job: null,
    starting: false,
    isRunning: false,
  },
};

export default meta;
type Story = StoryObj<typeof EmptyBucketDialog>;

/** Delete is disabled until the bucket name is typed exactly. */
export const Confirmation: Story = {};

export const NoObjectCount: Story = {
  args: { totalObjectCount: undefined },
};

export const InProgress: Story = {
  args: {
    job: job({ deletedCount: 7400 }),
    isRunning: true,
  },
};

export const Completed: Story = {
  args: {
    job: job({
      status: BulkDeleteJobStatus.Completed,
      deletedCount: 20_000,
      completedAt: '2026-04-01T10:04:00Z',
    }),
  },
};

/** Object-lock retention is the usual reason objects survive an empty. */
export const CompletedWithErrors: Story = {
  args: {
    job: job({
      status: BulkDeleteJobStatus.CompletedWithErrors,
      deletedCount: 19_988,
      failedCount: 12,
      failures: Array.from({ length: 12 }, (_, i) => ({
        key: `legal/contract-${i}.pdf`,
        code: 'AccessDenied',
        message: 'under retention',
      })),
      completedAt: '2026-04-01T10:04:00Z',
    }),
  },
};

/**
 * When more objects failed than we hold reasons for (the failure sample is
 * capped), we state the count without claiming a single cause.
 */
export const CompletedWithManyErrors: Story = {
  args: {
    job: job({
      status: BulkDeleteJobStatus.CompletedWithErrors,
      deletedCount: 4_800,
      failedCount: 2_400,
      failures: Array.from({ length: 100 }, (_, i) => ({
        key: `legal/contract-${i}.pdf`,
        code: 'AccessDenied',
        message: 'under retention',
      })),
      completedAt: '2026-04-01T10:04:00Z',
    }),
  },
};

export const Failed: Story = {
  args: {
    job: job({
      status: BulkDeleteJobStatus.Failed,
      deletedCount: 300,
      error: 'Tenant is not provisioned in region eu-west-1',
      completedAt: '2026-04-01T10:01:00Z',
    }),
  },
};
