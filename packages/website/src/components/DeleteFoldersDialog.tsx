import { Fragment } from 'react';
import { DialogTitle } from '@headlessui/react';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/ssr';

import type { BulkDeleteJob } from '@filone/shared';

import { Button } from './Button';
import { IconBox } from './IconBox';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { ProgressBar } from './ProgressBar';
import { OUTCOME_ICONS } from './bulk-delete-outcome-icons';
import { describeBulkDeleteOutcome, summarizeBulkDeleteJobs } from '../lib/bulk-delete-outcome.js';

/** Folders named in the confirmation; the rest are counted. */
const MAX_NAMED_FOLDERS = 3;

export type DeleteFoldersDialogProps = {
  open: boolean;
  onClose: () => void;
  /** The selected folders' full prefixes, each ending in '/'. */
  folderPrefixes: string[];
  /** Objects selected alongside the folders, deleted in the same confirmation. */
  objectCount: number;
  onConfirm: () => void;
  /** One job per folder, empty until the deletion starts. */
  jobs: BulkDeleteJob[];
  starting: boolean;
  isRunning: boolean;
};

function pluralize(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

/** What the selection holds, as the title names it: "2 folders and 3 objects". */
function describeSelection(folderCount: number, objectCount: number): string {
  const folders = pluralize(folderCount, 'folder');
  return objectCount > 0 ? `${folders} and ${pluralize(objectCount, 'object')}` : folders;
}

/**
 * Confirmation for deleting folders with everything inside them. The deletion
 * runs server-side and can take a while on a large folder, so, as when emptying
 * a bucket, the same dialog carries the progress and the final report.
 */
export function DeleteFoldersDialog({
  open,
  onClose,
  folderPrefixes,
  objectCount,
  onConfirm,
  jobs,
  starting,
  isRunning,
}: DeleteFoldersDialogProps) {
  // Once a job exists the work is server-side, so there is nothing left to
  // confirm and closing the dialog does not stop it.
  const started = jobs.length > 0;
  const summary = started ? summarizeBulkDeleteJobs(jobs) : null;
  const outcome =
    summary && !isRunning
      ? describeBulkDeleteOutcome(summary, jobs.length === 1 ? 'Folder deleted' : 'Folders deleted')
      : null;
  const icon = outcome
    ? OUTCOME_ICONS[outcome.tone]
    : { icon: WarningCircleIcon, color: 'red' as const };
  // While it runs the title says what is under way, and counts only the
  // folders: the objects selected with them were deleted when it started.
  const title =
    outcome?.title ??
    (summary
      ? `Deleting ${pluralize(folderPrefixes.length, 'folder')}`
      : `Delete ${describeSelection(folderPrefixes.length, objectCount)}`);

  return (
    <Modal open={open} onClose={onClose} size="sm" testId="delete-folders-dialog">
      <ModalBody>
        <div className="flex flex-col items-center gap-3 pt-6 pb-0 text-center">
          <IconBox icon={icon.icon} color={icon.color} size="lg" />
          <div className="flex w-full flex-col gap-1">
            <DialogTitle as="p" className="text-base font-medium text-zinc-900">
              {title}
            </DialogTitle>
            {outcome ? (
              <p className="text-sm text-zinc-500">{outcome.description}</p>
            ) : summary ? (
              <div className="flex w-full flex-col gap-2">
                {/* No total: the job counts every version it deletes, and
                    nothing knows ahead of time how many a folder holds. */}
                <p className="text-sm text-zinc-500">
                  Deleted {summary.deletedCount.toLocaleString()} so far. You can close this and it
                  will keep running.
                </p>
                <ProgressBar indeterminate label="Deletion progress" />
              </div>
            ) : (
              <ConfirmationLine folderPrefixes={folderPrefixes} objectCount={objectCount} />
            )}
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <div className="flex w-full gap-3">
          {/* Close spans the footer on its own; before that, Cancel takes only
              the width its label needs so the destructive label (and its
              spinner) stay on one line. */}
          <Button
            id="delete-folders-cancel-button"
            variant="ghost"
            className={started ? 'flex-1' : undefined}
            onClick={onClose}
          >
            {started ? 'Close' : 'Cancel'}
          </Button>
          {!started && (
            <Button
              id="delete-folders-confirm-button"
              variant="destructive"
              className="flex-1"
              loading={starting}
              loadingLabel="Starting deletion"
              onClick={onConfirm}
            >
              Delete
            </Button>
          )}
        </div>
      </ModalFooter>
    </Modal>
  );
}

/**
 * Names the folders, since a folder's row shows nothing of what it holds, and
 * says that all of it goes. The full prefix, not the row's name, so a reader
 * deep in a bucket sees exactly which path is deleted.
 */
function ConfirmationLine({
  folderPrefixes,
  objectCount,
}: {
  folderPrefixes: string[];
  objectCount: number;
}) {
  const named = folderPrefixes.slice(0, MAX_NAMED_FOLDERS);
  const unnamed = folderPrefixes.length - named.length;
  const parts = [
    ...named.map((prefix) => (
      <span key={prefix} className="font-medium break-all text-zinc-900">
        {prefix}
      </span>
    )),
    ...(unnamed > 0 ? [<span key="more">{pluralize(unnamed, 'more folder')}</span>] : []),
  ];

  return (
    <p className="text-sm text-zinc-500">
      Everything in{' '}
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && (i === parts.length - 1 ? ' and ' : ', ')}
          {part}
        </Fragment>
      ))}{' '}
      will be permanently deleted, including every previous version
      {objectCount > 0 && `, along with ${pluralize(objectCount, 'selected object')}`}. This cannot
      be undone.
    </p>
  );
}
