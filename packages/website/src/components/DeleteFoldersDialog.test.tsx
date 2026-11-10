import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { BulkDeleteJobStatus, BulkDeleteScope, S3Region, type BulkDeleteJob } from '@filone/shared';

import { DeleteFoldersDialog, type DeleteFoldersDialogProps } from './DeleteFoldersDialog';

function job(overrides: Partial<BulkDeleteJob> = {}): BulkDeleteJob {
  return {
    jobId: 'any-job',
    bucketName: 'any-bucket',
    region: S3Region.EuWest1,
    prefix: 'any-folder/',
    scope: BulkDeleteScope.AllVersions,
    status: BulkDeleteJobStatus.Running,
    deletedCount: 0,
    failedCount: 0,
    failures: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** The dialog before anything starts; each test sets only what it is about. */
function renderDialog(props: Partial<DeleteFoldersDialogProps> = {}) {
  return render(
    <DeleteFoldersDialog
      open
      onClose={() => {}}
      folderPrefixes={['any-folder/']}
      objectCount={0}
      onConfirm={() => {}}
      jobs={[]}
      starting={false}
      isRunning={false}
      {...props}
    />,
  );
}

function getDescription() {
  return screen.getByText(/will be permanently deleted/);
}

describe('DeleteFoldersDialog: confirming', () => {
  it('names the folder and says everything in it is permanently deleted', () => {
    renderDialog({ folderPrefixes: ['any/nested-folder/'] });

    expect(screen.getByText('Delete 1 folder')).toBeInTheDocument();
    expect(getDescription()).toHaveTextContent(
      'Everything in any/nested-folder/ will be permanently deleted, including every previous version. This cannot be undone.',
    );
  });

  it('names the first three folders and counts the rest', () => {
    renderDialog({ folderPrefixes: ['a/', 'b/', 'c/', 'd/', 'e/'] });

    expect(getDescription()).toHaveTextContent('Everything in a/, b/, c/ and 2 more folders will');
  });

  it('counts the objects selected alongside the folders', () => {
    renderDialog({ folderPrefixes: ['a/', 'b/'], objectCount: 3 });

    expect(screen.getByText('Delete 2 folders and 3 objects')).toBeInTheDocument();
    expect(getDescription()).toHaveTextContent(
      'including every previous version, along with 3 selected objects.',
    );
  });
});

describe('DeleteFoldersDialog: once started', () => {
  it('shows how much is deleted so far while the jobs run', () => {
    renderDialog({ jobs: [job({ deletedCount: 1200 })], isRunning: true });

    expect(screen.getByText('Deleting 1 folder')).toBeInTheDocument();
    expect(screen.getByText(/so far/)).toHaveTextContent(
      `Deleted ${(1200).toLocaleString()} so far. You can close this and it will keep running.`,
    );
    expect(screen.getByRole('progressbar', { name: 'Deletion progress' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('reports the folders deleted once every job completes', () => {
    renderDialog({
      folderPrefixes: ['a/', 'b/'],
      jobs: [
        job({ status: BulkDeleteJobStatus.Completed, deletedCount: 2 }),
        job({ status: BulkDeleteJobStatus.Completed, deletedCount: 3 }),
      ],
    });

    expect(screen.getByText('Folders deleted')).toBeInTheDocument();
    expect(screen.getByText('Deleted 5 objects.')).toBeInTheDocument();
  });
});
