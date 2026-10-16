import { useRef, useState } from 'react';
import { DialogTitle } from '@headlessui/react';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/ssr';

import { Modal, ModalBody, ModalFooter } from './Modal';
import { Button } from './Button';
import { IconBox } from './IconBox';
import { Spinner } from './Spinner';
import type { BucketContents } from '../lib/use-delete-bucket.js';

export type DeleteBucketDialogProps = {
  /** The bucket being deleted; `null` closes the dialog. */
  bucketName: string | null;
  contents: BucketContents;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  /** Opens the bucket's page, where Empty bucket lives. */
  onOpenBucket: () => void;
};

/**
 * Deleting a bucket, which S3 allows only once it is empty.
 *
 * One dialog with three faces, so it changes its content rather than closing
 * and reopening: a short check while it asks S3 what the bucket holds, then
 * either the confirmation or, for a bucket with objects left, a pointer to the
 * bucket page. Offering Delete on a full bucket would only earn a refusal, and
 * emptying it from here would delete objects the user never got to look at.
 */
export function DeleteBucketDialog({
  bucketName,
  contents,
  onClose,
  onConfirm,
  onOpenBucket,
}: DeleteBucketDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const open = bucketName !== null;

  // The panel fades out after `bucketName` goes null, and the contents query
  // resets with it. Holding the last open state keeps the closing panel from
  // flicking back to "checking" on its way out.
  const shown = useRef({ bucketName: '', contents });
  if (open) shown.current = { bucketName, contents };
  const notEmpty = shown.current.contents === 'not-empty';
  const checking = shown.current.contents === 'checking';

  async function handleConfirm() {
    setDeleting(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={deleting ? () => {} : onClose}
      size="sm"
      testId="delete-bucket-dialog"
    >
      <ModalBody>
        <DialogCopy contents={shown.current.contents} />
      </ModalBody>
      <ModalFooter>
        <div className="flex w-full gap-3">
          <Button
            id="delete-bucket-cancel-button"
            variant="ghost"
            className="flex-1"
            onClick={onClose}
            disabled={deleting}
          >
            Cancel
          </Button>
          {notEmpty ? (
            <Button
              id="delete-bucket-open-button"
              variant="primary"
              className="flex-1"
              onClick={onOpenBucket}
            >
              Go to bucket
            </Button>
          ) : (
            <Button
              id="delete-bucket-confirm-button"
              variant="destructive"
              className="flex-1"
              disabled={checking}
              loading={deleting}
              loadingLabel="Deleting bucket"
              onClick={() => void handleConfirm()}
            >
              Delete bucket
            </Button>
          )}
        </div>
      </ModalFooter>
    </Modal>
  );
}

/** The icon, title and line above the buttons, for each face of the dialog. */
function DialogCopy({ contents }: { contents: BucketContents }) {
  const notEmpty = contents === 'not-empty';
  return (
    <div className="flex flex-col items-center gap-3 px-2 pt-6 pb-0 text-center">
      <IconBox icon={WarningCircleIcon} color={notEmpty ? 'amber' : 'red'} size="lg" />
      <div className="flex flex-col gap-1">
        <DialogTitle as="p" className="text-base font-medium text-zinc-900">
          {notEmpty ? 'This bucket isn’t empty' : 'Delete bucket'}
        </DialogTitle>
        <DialogDescription contents={contents} />
      </div>
    </div>
  );
}

function DialogDescription({ contents }: { contents: BucketContents }) {
  if (contents === 'checking') {
    return (
      <div className="flex items-center justify-center gap-2 text-sm text-zinc-500">
        <Spinner ariaLabel="Checking the bucket" size={14} colorClassName="text-current" />
        Checking whether the bucket is empty
      </div>
    );
  }
  return (
    <p className="text-sm text-zinc-500">
      {contents === 'not-empty'
        ? 'Delete its objects and object versions before deleting the bucket. You can empty it from the bucket page.'
        : 'This bucket will be permanently deleted.'}
    </p>
  );
}
