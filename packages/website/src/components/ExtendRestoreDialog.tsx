import { useRef } from 'react';

import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { Button } from './Button';
import { CostColumnsHeader, CostRowAmounts, CostRowText } from './ColdStorageFacts';
import {
  COLD_PRICE_PER_TB_MONTH,
  DAY_MS,
  WARM_MIN_DAYS,
  formatShortDate,
  formatUsd,
  getBillableBytes,
  getMonthlyCost,
  getWarmPeriodCost,
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
 * Confirms an extension before charging for it, in the same Now and Monthly
 * table the restore dialog uses, so the two read as one decision. An extension
 * is a purchase, so it never happens on a single click.
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

  const bytes = getBillableBytes(current.bytes);
  const cost = getWarmPeriodCost(bytes);
  const costs = {
    now: formatUsd(cost),
    monthly: formatUsd(getMonthlyCost(bytes, COLD_PRICE_PER_TB_MONTH)),
    monthlyNote: 'no change',
  };
  const newEnd = formatShortDate(current.warmUntil + WARM_MIN_DAYS * DAY_MS);

  return (
    <Modal open={state !== null} onClose={onClose} size="md" testId="extend-restore-dialog">
      <ModalHeader onClose={onClose} description="Keep the restored copy for 2 more weeks.">
        Extend {bucketName}
      </ModalHeader>
      <ModalBody>
        <CostColumnsHeader />
        <div className="flex items-start gap-3 rounded-lg border border-zinc-200 px-4 py-3 text-ui">
          <span className="flex-1">
            <CostRowText
              title="2 more weeks"
              description={`Downloadable until ${newEnd}, then the restored copy is deleted. Your frozen copy stays untouched.`}
              costs={costs}
            />
          </span>
          <CostRowAmounts costs={costs} />
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
          Extend for {formatUsd(cost)}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
