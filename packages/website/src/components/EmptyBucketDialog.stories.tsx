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

/** The gap between confirming and the job existing: the button holds a spinner. */
export const Starting: Story = {
  args: { starting: true },
};

/**
 * Current scope deletes only current object keys, the same thing
 * totalObjectCount counts, so the two are comparable and the bar shows a real
 * percentage.
 */
export const InProgress: Story = {
  args: {
    job: job({ deletedCount: 7400, scope: BulkDeleteScope.Current }),
    isRunning: true,
  },
};

/**
 * AllVersions (the default scope) counts every version and delete marker, not
 * just current keys, so deletedCount is not comparable to totalObjectCount
 * even though both are present. The bar shows activity without claiming a
 * percentage it can't back up.
 */
export const InProgressAllVersions: Story = {
  args: {
    job: job({ deletedCount: 7400 }),
    isRunning: true,
  },
};

/** Without a total there is nothing to measure against, so no numeric bar. */
export const InProgressWithoutTotal: Story = {
  args: {
    totalObjectCount: undefined,
    job: job({ deletedCount: 7400, scope: BulkDeleteScope.Current }),
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
