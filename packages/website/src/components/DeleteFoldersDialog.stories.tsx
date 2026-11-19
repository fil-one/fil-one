import type { Meta, StoryObj } from '@storybook/react-vite';

import { BulkDeleteJobStatus, BulkDeleteScope, S3Region, type BulkDeleteJob } from '@filone/shared';

import { DeleteFoldersDialog } from './DeleteFoldersDialog';

function job(overrides: Partial<BulkDeleteJob> = {}): BulkDeleteJob {
  return {
    jobId: 'job-1',
    bucketName: 'my-bucket',
    region: S3Region.EuWest1,
    prefix: 'images/',
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

const meta: Meta<typeof DeleteFoldersDialog> = {
  title: 'Components/DeleteFoldersDialog',
  component: DeleteFoldersDialog,
  args: {
    open: true,
    onClose: () => {},
    onConfirm: () => {},
    folderPrefixes: ['images/'],
    objectCount: 0,
    jobs: [],
    starting: false,
    isRunning: false,
  },
};

export default meta;
type Story = StoryObj<typeof DeleteFoldersDialog>;

/** One folder: the confirmation names its full path. */
export const Confirmation: Story = {};

/** A deep path wraps rather than overflowing the dialog. */
export const LongPath: Story = {
  args: {
    folderPrefixes: ['customers/2026/eu-west/archive/exports/quarterly-reports-final/'],
  },
};

/**
 * Several folders and some objects: three folders are named, the rest counted,
 * and the objects selected alongside are deleted in the same confirmation.
 */
export const FoldersAndObjects: Story = {
  args: {
    folderPrefixes: ['images/', 'docs/', 'logs/', 'exports/', 'tmp/'],
    objectCount: 3,
  },
};

/** The gap between confirming and the jobs existing: the button holds a spinner. */
export const Starting: Story = {
  args: { starting: true },
};

/**
 * The jobs run on the server. No total: each counts every version it deletes,
 * and nothing knows ahead of time how many a folder holds.
 */
export const InProgress: Story = {
  args: {
    folderPrefixes: ['images/', 'docs/'],
    jobs: [
      job({ deletedCount: 4200 }),
      job({ prefix: 'docs/', status: BulkDeleteJobStatus.Completed, deletedCount: 812 }),
    ],
    isRunning: true,
  },
};

export const Completed: Story = {
  args: {
    jobs: [job({ status: BulkDeleteJobStatus.Completed, deletedCount: 5012 })],
  },
};

export const CompletedSeveralFolders: Story = {
  args: {
    folderPrefixes: ['images/', 'docs/'],
    jobs: [
      job({ status: BulkDeleteJobStatus.Completed, deletedCount: 4200 }),
      job({ prefix: 'docs/', status: BulkDeleteJobStatus.Completed, deletedCount: 812 }),
    ],
  },
};

/** Object-lock retention is the usual reason a folder keeps some objects. */
export const SomeObjectsRemain: Story = {
  args: {
    jobs: [
      job({
        status: BulkDeleteJobStatus.CompletedWithErrors,
        deletedCount: 4800,
        failedCount: 2,
        failures: [
          { key: 'images/a.jpg', code: 'AccessDenied', message: 'under a retention period' },
          { key: 'images/b.jpg', code: 'AccessDenied', message: 'under a retention period' },
        ],
      }),
    ],
  },
};

export const Failed: Story = {
  args: {
    jobs: [
      job({
        status: BulkDeleteJobStatus.Failed,
        deletedCount: 120,
        error: 'Your access to my-bucket no longer permits bulk deletion.',
      }),
    ],
  },
};
