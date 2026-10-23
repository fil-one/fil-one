import { useRef } from 'react';

import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { Button } from './Button';
import {
  COLD_PRICE_PER_TB_MONTH,
  DAY_MS,
  WARM_MIN_DAYS,
  formatMoment,
  formatUsd,
  getBillableBytes,
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
 * Confirms an extension before charging for it: what it costs, the new date
 * the restored copy lasts until, and that the frozen copy is untouched. An
 * extension is a purchase, so it never happens on a single click.
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

  const cost = getWarmPeriodCost(getBillableBytes(current.bytes));
  const newEnd = formatMoment(current.warmUntil + WARM_MIN_DAYS * DAY_MS);

  return (
    <Modal open={state !== null} onClose={onClose} size="sm" testId="extend-restore-dialog">
      <ModalHeader onClose={onClose} description={bucketName}>
        Extend restore by 2 weeks
      </ModalHeader>
      <ModalBody>
        <dl className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 text-ui">
          <div className="flex items-center justify-between gap-3 px-4 py-2">
            <dt className="text-zinc-600">Charged now</dt>
            <dd className="font-medium text-zinc-900 tabular-nums">{formatUsd(cost)}</dd>
          </div>
          <div className="flex items-center justify-between gap-3 px-4 py-2">
            <dt className="text-zinc-600">Downloadable until</dt>
            <dd className="font-medium text-zinc-900">{newEnd}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-zinc-500">
          Your frozen copy doesn’t change and keeps billing at {formatUsd(COLD_PRICE_PER_TB_MONTH)}
          /TB-month.
        </p>
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
