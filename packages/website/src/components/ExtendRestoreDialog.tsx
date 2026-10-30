import { useRef } from 'react';

import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { Button } from './Button';
import { RateColumnHeader, RateRowAmount, RateRowText } from './ColdStorageFacts';
import {
  COLD_PRICE_PER_TB_MONTH,
  DAY_MS,
  WARM_MIN_DAYS,
  WARM_PRICE_PER_TB_MONTH,
  formatRate,
  formatShortDate,
  type WarmState,
} from '../lib/cold-storage-prototype.js';

type ExtendRestoreDialogProps = {
  /** The restored bucket to extend; `null` closes the dialog. */
  state: WarmState | null;
  bucketName: string;
  onClose: () => void;
  onConfirm: (state: WarmState) => void;
};

/**
 * Confirms an extension before billing for it, in the same Rate table the
 * restore dialog uses, so the two read as one decision. An extension is a
 * purchase, so it never happens on a single click.
 */
export function ExtendRestoreDialog({
  state,
  bucketName,
  onClose,
  onConfirm,
}: ExtendRestoreDialogProps) {
  // Keeps the copy in place while the panel fades out after `state` goes null.
  const shown = useRef<WarmState | null>(null);
  if (state) shown.current = state;
  const current = shown.current;
  if (!current) return null;

  const rate = { rate: formatRate(WARM_PRICE_PER_TB_MONTH), rateNote: 'no change' };
  const newEnd = formatShortDate(current.warmUntil + WARM_MIN_DAYS * DAY_MS);

  return (
    <Modal open={state !== null} onClose={onClose} size="md" testId="extend-restore-dialog">
      <ModalHeader onClose={onClose} description="Keep the restored copy for 2 more weeks.">
        Extend {bucketName}
      </ModalHeader>
      <ModalBody>
        <RateColumnHeader />
        <div className="flex items-start gap-3 rounded-lg border border-zinc-200 px-4 py-3 text-ui">
          <span className="flex-1">
            <RateRowText
              title="2 more weeks"
              description={`Downloadable until ${newEnd}, then the restored copy is deleted. Your frozen copy keeps billing at ${formatRate(COLD_PRICE_PER_TB_MONTH)}.`}
              rate={rate}
            />
          </span>
          <RateRowAmount rate={rate} />
        </div>
      </ModalBody>
      <ModalFooter fullWidth>
        <Button id="extend-restore-cancel-button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          id="extend-restore-confirm-button"
          variant="primary"
          onClick={() => {
            onConfirm(current);
            onClose();
          }}
        >
          Extend 2 weeks
        </Button>
      </ModalFooter>
    </Modal>
  );
}
