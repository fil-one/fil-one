import { useRef } from 'react';

import { ConfirmDialog } from './ConfirmDialog';
import { useToast } from './Toast';
import {
  COLD_PRICE_PER_TB_MONTH,
  MIN_TERM_DAYS,
  WARM_PRICE_PER_TB_MONTH,
  deleteFrozenCopy,
  formatRate,
  formatShortDate,
  isInMinimumTerm,
  trackColdStorage,
  type WarmState,
} from '../lib/cold-storage-prototype.js';

type DeleteFrozenCopyDialogProps = {
  /** The restored bucket whose frozen copy goes; `null` closes the dialog. */
  state: WarmState | null;
  bucketName: string;
  region: string;
  onClose: () => void;
};

/**
 * Confirms deleting the frozen copy of a restored bucket, which leaves the
 * restored copy as ordinary standard storage. Offered only while restored, so
 * the data is downloadable before its frozen copy goes.
 */
export function DeleteFrozenCopyDialog({
  state,
  bucketName,
  region,
  onClose,
}: DeleteFrozenCopyDialogProps) {
  const { toast } = useToast();
  // Keeps the copy in place while the panel fades out after `state` goes null.
  const shown = useRef<WarmState | null>(null);
  if (state) shown.current = state;
  const current = shown.current;
  const termNote =
    current && isInMinimumTerm(current)
      ? ` The rest of the ${MIN_TERM_DAYS}-day freeze, to ${formatShortDate(current.termEndsAt)}, still bills at ${formatRate(COLD_PRICE_PER_TB_MONTH)}.`
      : '';

  return (
    <ConfirmDialog
      open={state !== null}
      onClose={onClose}
      onConfirm={() => {
        deleteFrozenCopy(bucketName, region);
        trackColdStorage('frozen copy deleted');
        toast.success(`${bucketName} is in standard storage`);
        return Promise.resolve();
      }}
      title="Delete frozen copy?"
      description={`The restored copy stays as standard storage at ${formatRate(WARM_PRICE_PER_TB_MONTH)}.${termNote}`}
      confirmLabel="Delete frozen copy"
    />
  );
}
