import { useRef } from 'react';

import { S3_REGION } from '@filone/shared';

import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { Alert } from './Alert';
import { Button } from './Button';
import { useToast } from './Toast';
import type { ColdStorageTarget } from './FreezeBucketDialog';
import { RateColumnHeader, RateRowAmount, RateRowText, type RowRate } from './ColdStorageFacts';
import {
  COLD_PRICE_PER_TB_MONTH,
  DAY_MS,
  WARM_MIN_DAYS,
  WARM_PRICE_PER_TB_MONTH,
  formatRate,
  formatShortDate,
  useColdStorage,
  warmBucket,
  trackColdStorage,
} from '../lib/cold-storage-prototype.js';

type GetDataBackDialogProps = {
  /** The frozen bucket to restore; `null` closes the dialog. */
  target: ColdStorageTarget | null;
  onClose: () => void;
};

/**
 * Confirms a restore: a downloadable copy for 2 weeks, beside the frozen copy
 * that stays. There is one way back. Keeping the data in standard storage for
 * good is a restore followed by deleting the frozen copy, so the data is never
 * out of reach while the bucket changes tier.
 */
export function GetDataBackDialog({ target, onClose }: GetDataBackDialogProps) {
  // Keeps the copy in place while the panel fades out after `target` goes null.
  const shown = useRef<ColdStorageTarget>({ bucketName: '', region: S3_REGION });
  if (target) shown.current = target;
  const { bucketName, region } = shown.current;
  const state = useColdStorage(bucketName, region);
  const { toast } = useToast();

  if (state?.status !== 'frozen') return null;

  const rate: RowRate = {
    rate: formatRate(WARM_PRICE_PER_TB_MONTH),
    rateNote: `${WARM_MIN_DAYS / 7}-week minimum`,
  };

  function handleConfirm() {
    if (state?.status !== 'frozen') return;
    trackColdStorage('restore confirmed');
    warmBucket(bucketName, region, state);
    toast.success('Restoring started. We’ll email you when downloads work.');
    onClose();
  }

  return (
    <Modal open={target !== null} onClose={onClose} size="md" testId="get-data-back-dialog">
      <ModalHeader onClose={onClose} description="Free to start. Downloads work in about an hour.">
        Restore {bucketName}
      </ModalHeader>
      <ModalBody>
        <RateColumnHeader />
        <div className="flex items-start gap-3 rounded-lg border border-zinc-200 px-4 py-3 text-ui">
          <span className="flex-1">
            <RateRowText
              title="Restored copy for 2 weeks"
              description={`Downloadable until ${formatShortDate(Date.now() + WARM_MIN_DAYS * DAY_MS)}, then deleted. Billed for the full 2 weeks, even if you delete it sooner.`}
              rate={rate}
            />
          </span>
          <RateRowAmount rate={rate} />
        </div>
        <div className="mt-3">
          <Alert
            variant="grey"
            showIcon={false}
            assertive={false}
            description={`Your frozen copy stays and keeps billing at ${formatRate(COLD_PRICE_PER_TB_MONTH)}. To keep the data in standard storage, delete the frozen copy once the restore is ready.`}
          />
        </div>
      </ModalBody>
      <ModalFooter fullWidth>
        <Button id="get-data-back-cancel-button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button id="get-data-back-confirm-button" variant="primary" onClick={handleConfirm}>
          Restore for 2 weeks
        </Button>
      </ModalFooter>
    </Modal>
  );
}
