import { useState } from 'react';
import { DialogTitle } from '@headlessui/react';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/ssr';

import { BulkDeleteJobStatus, type BulkDeleteJob } from '@filone/shared';

import { Alert } from './Alert';
import { Button } from './Button';
import { IconBox } from './IconBox';
import { Input } from './Input';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { ProgressBar } from './ProgressBar';
import { Spinner } from './Spinner';

export type EmptyBucketDialogProps = {
  open: boolean;
  onClose: () => void;
  bucketName: string;
  /** Total objects in the bucket, used to show progress against a target. */
  totalObjectCount?: number;
  onConfirm: () => void;
  job: BulkDeleteJob | null;
  starting: boolean;
  isRunning: boolean;
};

/**
 * Confirmation for emptying a whole bucket. Deletion runs server-side and can
 * take a while on a large bucket, so the same dialog carries the progress and
 * the final report rather than handing off to a toast.
 */
export function EmptyBucketDialog({
  open,
  onClose,
  bucketName,
  totalObjectCount,
  onConfirm,
  job,
  starting,
  isRunning,
}: EmptyBucketDialogProps) {
  const [typedName, setTypedName] = useState('');
  const confirmed = typedName === bucketName;
  // Once the job exists the work is server-side, so there is nothing left to
  // confirm and closing the dialog does not stop it.
  const started = job !== null;

  function handleClose() {
    setTypedName('');
    onClose();
  }

  return (
    <Modal open={open} onClose={handleClose} size="sm" testId="empty-bucket-dialog">
      <ModalBody>
        <div className="flex flex-col items-center gap-3 px-2 pt-6 pb-0 text-center">
          <IconBox icon={WarningCircleIcon} color="red" size="lg" />
          <div className="flex flex-col gap-1">
            <DialogTitle as="p" className="text-base font-medium text-zinc-900">
              Empty this bucket
            </DialogTitle>
            <BulkDeleteBody
              bucketName={bucketName}
              totalObjectCount={totalObjectCount}
              job={job}
              isRunning={isRunning}
            />
          </div>

          {!started && (
            <div className="mt-2 w-full text-left">
              <label
                htmlFor="empty-bucket-confirm"
                className="mb-1 block text-xs font-medium text-zinc-700"
              >
                Type <span className="font-mono text-zinc-900">{bucketName}</span> to confirm
              </label>
              <Input
                id="empty-bucket-confirm"
                value={typedName}
                onChange={setTypedName}
                placeholder={bucketName}
                autoComplete="off"
              />
            </div>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <div className="flex w-full gap-3">
          <Button
            id="empty-bucket-cancel-button"
            variant="ghost"
            className="flex-1"
            onClick={handleClose}
          >
            {started ? 'Close' : 'Cancel'}
          </Button>
          {!started && (
            <Button
              id="empty-bucket-confirm-button"
              variant="destructive"
              className="flex-1"
              disabled={!confirmed || starting}
              onClick={onConfirm}
            >
              {starting && <Spinner ariaLabel="Starting deletion" size={14} />}
              Delete everything
            </Button>
          )}
        </div>
      </ModalFooter>
    </Modal>
  );
}

function BulkDeleteBody({
  bucketName,
  totalObjectCount,
  job,
  isRunning,
}: {
  bucketName: string;
  totalObjectCount?: number;
  job: BulkDeleteJob | null;
  isRunning: boolean;
}) {
  if (!job) {
    const count =
      totalObjectCount !== undefined
        ? `all ${totalObjectCount.toLocaleString()} objects`
        : 'every object';
    return (
      <p className="text-sm text-zinc-500">
        This permanently deletes {count} in {bucketName}, including every previous version. It
        cannot be undone.
      </p>
    );
  }

  if (isRunning) {
    return (
      <div className="flex w-full flex-col gap-2">
        <p className="text-sm text-zinc-500">
          Deleted {job.deletedCount.toLocaleString()}
          {totalObjectCount !== undefined && ` of ${totalObjectCount.toLocaleString()}`}. You can
          close this and it will keep running.
        </p>
        {totalObjectCount !== undefined && totalObjectCount > 0 && (
          <ProgressBar
            value={Math.min(100, Math.round((job.deletedCount / totalObjectCount) * 100))}
            label="Deletion progress"
          />
        )}
      </div>
    );
  }

  return <BulkDeleteOutcome job={job} />;
}

function BulkDeleteOutcome({ job }: { job: BulkDeleteJob }) {
  if (job.status === BulkDeleteJobStatus.Failed) {
    return (
      <Alert
        variant="red"
        title="Deletion stopped"
        description={job.error ?? 'The deletion could not be completed.'}
      />
    );
  }

  if (job.status === BulkDeleteJobStatus.CompletedWithErrors) {
    return (
      <Alert
        variant="amber"
        title={`Deleted ${job.deletedCount.toLocaleString()}, ${job.failedCount.toLocaleString()} left`}
        description={`${job.failedCount.toLocaleString()} objects could not be deleted, usually because they are under a retention lock. ${describeFirstFailure(job)}`}
      />
    );
  }

  return (
    <Alert
      variant="green"
      title="Bucket emptied"
      description={`Deleted ${job.deletedCount.toLocaleString()} objects.`}
    />
  );
}

function describeFirstFailure(job: BulkDeleteJob): string {
  const first = job.failures[0];
  if (!first) return '';
  return `First: ${first.key} (${first.code}).`;
}
