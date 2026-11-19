import { useState } from 'react';
import { DialogTitle } from '@headlessui/react';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/ssr';

import { BulkDeleteScope, type BulkDeleteJob } from '@filone/shared';

import { Button } from './Button';
import { IconBox } from './IconBox';
import { Input } from './Input';
import { Label } from './Label';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { ProgressBar } from './ProgressBar';
import { OUTCOME_ICONS } from './bulk-delete-outcome-icons';
import { describeBulkDeleteOutcome } from '../lib/bulk-delete-outcome.js';

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
  // A finished job takes over the icon and the title rather than reporting
  // itself in a banner underneath them, which would state the outcome twice.
  const outcome = job && !isRunning ? describeOutcome(job) : null;

  function handleClose() {
    setTypedName('');
    onClose();
  }

  return (
    <Modal open={open} onClose={handleClose} size="sm" testId="empty-bucket-dialog">
      <ModalBody>
        {/* No horizontal padding: the input and the alerts share the footer's
            px-6 so their edges line up with the buttons. */}
        <div className="flex flex-col items-center gap-3 pt-6 pb-0 text-center">
          <IconBox
            icon={outcome?.icon ?? WarningCircleIcon}
            color={outcome?.color ?? 'red'}
            size="lg"
          />
          <div className="flex w-full flex-col gap-1">
            <DialogTitle as="p" className="text-base font-medium text-zinc-900">
              {outcome?.title ?? 'Empty this bucket'}
            </DialogTitle>
            <BulkDeleteBody
              bucketName={bucketName}
              totalObjectCount={totalObjectCount}
              job={job}
              isRunning={isRunning}
            />
          </div>

          {!started && (
            <div className="mt-2 flex w-full flex-col gap-1 text-left">
              {/* Label rather than FormField: the copy carries the bucket name
                  as inline markup, and FormField's label is a plain string. */}
              <Label htmlFor="empty-bucket-confirm">
                Type <span className="font-mono">{bucketName}</span> to confirm
              </Label>
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
          {/* Close spans the footer on its own; before that, Cancel takes only
              the width its label needs so the longer destructive label (and its
              spinner) stay on one line. */}
          <Button
            id="empty-bucket-cancel-button"
            variant="ghost"
            className={started ? 'flex-1' : undefined}
            onClick={handleClose}
          >
            {started ? 'Close' : 'Cancel'}
          </Button>
          {!started && (
            <Button
              id="empty-bucket-confirm-button"
              variant="destructive"
              className="flex-1"
              disabled={!confirmed}
              loading={starting}
              loadingLabel="Starting deletion"
              onClick={onConfirm}
            >
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
    // No count here: the bucket's object count comes from analytics and lags
    // recent writes, so a stale number on a permanent-delete confirmation would
    // be worse than none.
    return (
      <p className="text-sm text-zinc-500">
        This permanently deletes all objects in {bucketName}, including every previous version. It
        cannot be undone.
      </p>
    );
  }

  if (isRunning) {
    // totalObjectCount is an analytics count of current object keys.
    // job.deletedCount only counts the same thing when the job itself is
    // scoped to current objects; the default scope deletes every version and
    // delete marker too, so the two numbers are different units and a job
    // past its first key can already "exceed" the total. Only pair them up
    // when they are actually comparable; otherwise show progress without
    // pretending to know the target.
    const comparableTotal =
      job.scope === BulkDeleteScope.Current &&
      totalObjectCount !== undefined &&
      totalObjectCount > 0
        ? totalObjectCount
        : undefined;

    return (
      <div className="flex w-full flex-col gap-2">
        <p className="text-sm text-zinc-500">
          Deleted {job.deletedCount.toLocaleString()}
          {comparableTotal !== undefined && ` of ${comparableTotal.toLocaleString()}`}. You can
          close this and it will keep running.
        </p>
        {comparableTotal !== undefined ? (
          <ProgressBar
            value={Math.min(100, Math.round((job.deletedCount / comparableTotal) * 100))}
            label="Deletion progress"
          />
        ) : (
          <ProgressBar indeterminate label="Deletion progress" />
        )}
      </div>
    );
  }

  return <p className="text-sm text-zinc-500">{describeOutcome(job).description}</p>;
}

/** The icon, title and copy a finished job replaces the header with. */
function describeOutcome(job: BulkDeleteJob) {
  const outcome = describeBulkDeleteOutcome(job, 'Bucket empty');
  return { ...outcome, ...OUTCOME_ICONS[outcome.tone] };
}
