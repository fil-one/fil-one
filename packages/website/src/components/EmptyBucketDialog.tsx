import { useState } from 'react';
import { DialogTitle } from '@headlessui/react';
import { CheckCircleIcon, WarningCircleIcon, WarningIcon } from '@phosphor-icons/react/dist/ssr';

import { BulkDeleteJobStatus, BulkDeleteScope, type BulkDeleteJob } from '@filone/shared';

import { Button } from './Button';
import { IconBox, type IconBoxColor } from './IconBox';
import { Input } from './Input';
import { Label } from './Label';
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
              disabled={!confirmed || starting}
              onClick={onConfirm}
            >
              {/* Button wraps its children in a plain span, so the spinner's
                  block-level root would sit above the label. This row keeps
                  them side by side, and text-current keeps the arc the same
                  colour as the label rather than brand blue. */}
              <span className="inline-flex items-center gap-2">
                {starting && (
                  <Spinner ariaLabel="Starting deletion" size={14} colorClassName="text-current" />
                )}
                Delete everything
              </span>
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

type Outcome = {
  icon: typeof WarningCircleIcon;
  color: IconBoxColor;
  title: string;
  description: string;
};

/** The icon, title and copy a finished job replaces the header with. */
function describeOutcome(job: BulkDeleteJob): Outcome {
  if (job.status === BulkDeleteJobStatus.Failed) {
    return {
      icon: WarningCircleIcon,
      color: 'red',
      title: 'Deletion stopped',
      description: job.error ?? 'The deletion could not be completed.',
    };
  }

  if (job.status === BulkDeleteJobStatus.CompletedWithErrors) {
    // The counts belong in the description as two sentences. Joining them in
    // the title ("Deleted 4,800, 2,400 left") put a clause comma next to the
    // thousands separators, so the numbers were hard to read apart.
    const deletedNoun = job.deletedCount === 1 ? 'object' : 'objects';
    return {
      icon: WarningIcon,
      color: 'amber',
      title: 'Some objects remain',
      description: `Deleted ${job.deletedCount.toLocaleString()} ${deletedNoun}. ${describeFailures(job)}`,
    };
  }

  const noun = job.deletedCount === 1 ? 'object' : 'objects';
  return {
    icon: CheckCircleIcon,
    color: 'green',
    title: 'Bucket empty',
    description: `Deleted ${job.deletedCount.toLocaleString()} ${noun}.`,
  };
}

/**
 * Explain why objects survived, collectively rather than by naming a file. We
 * state a reason only when the gateway gave a human message for every recorded
 * failure and they all agree (object-lock retention is the usual one). When any
 * reason is missing, they differ, or more objects failed than we hold reasons
 * for, we keep to the count rather than claim a cause that might not hold. The
 * per-object detail (including any retention window) lives on the object.
 */
function describeFailures(job: BulkDeleteJob): string {
  const count = job.failedCount;
  const noun = count === 1 ? 'object' : 'objects';
  const lead = `${count.toLocaleString()} ${noun} couldn't be deleted`;

  const messages = job.failures.map((f) => f.message?.trim()).filter((m): m is string => !!m);
  const reasons = new Set(messages);
  // Every one of the failed objects contributed the same message. `messages`
  // reaching `count` also implies we hold a reason for all of them (the sample
  // was not capped), so the collective claim is safe.
  if (messages.length === count && reasons.size === 1) {
    const [reason] = reasons;
    const subject = count === 1 ? "it's" : "they're";
    return `${lead} because ${subject} ${reason}.`;
  }
  return `${lead}.`;
}
