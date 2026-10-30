import { useRef } from 'react';
import { CalendarBlankIcon, ClockIcon } from '@phosphor-icons/react/dist/ssr';

import { S3_REGION, type S3Region } from '@filone/shared';

import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { Alert } from './Alert';
import { Button } from './Button';
import { PriceComparison, Term, TermList } from './ColdStorageFacts';
import { useToast } from './Toast';
import {
  COLD_PRICE_PER_TB_MONTH,
  MIN_TERM_DAYS,
  bytesToTb,
  formatUsd,
  formatTb,
  freezeBucket,
  getMonthlyCost,
  getStandardMonthlyCost,
  getWarmPeriodPricePerTb,
  useBucketBytes,
  trackColdStorage,
} from '../lib/cold-storage-prototype.js';

export type ColdStorageTarget = { bucketName: string; region: S3Region };

type FreezeBucketDialogProps = {
  /** The bucket to freeze; `null` closes the dialog. */
  target: ColdStorageTarget | null;
  onClose: () => void;
};

/**
 * The review before freezing: what the bucket costs now and frozen, the terms
 * that come with the lower price, and what stops working. The warning sits
 * before the button because backup tools failing overnight is the surprise most
 * likely to make someone regret freezing.
 */
export function FreezeBucketDialog({ target, onClose }: FreezeBucketDialogProps) {
  // The panel fades out after `target` goes null; holding the last target keeps
  // its copy in place on the way out.
  const shown = useRef<ColdStorageTarget>({ bucketName: '', region: S3_REGION });
  if (target) shown.current = target;
  const { bucketName, region } = shown.current;
  const bytes = useBucketBytes(bucketName, region) ?? 0;
  const { toast } = useToast();

  const today = getStandardMonthlyCost(bytes);
  const frozen = getMonthlyCost(bytes, COLD_PRICE_PER_TB_MONTH);

  function handleFreeze() {
    freezeBucket(bucketName, region, bytes);
    trackColdStorage('freeze confirmed', { sizeTb: String(Math.round(bytesToTb(bytes))) });
    toast.success(`${bucketName} is frozen`);
    onClose();
  }

  return (
    <Modal open={target !== null} onClose={onClose} size="md" testId="freeze-bucket-dialog">
      <ModalHeader
        onClose={onClose}
        description={`${formatTb(bytes)}, billed at ${formatUsd(COLD_PRICE_PER_TB_MONTH)}/TB-month while frozen.`}
      >
        Freeze {bucketName}
      </ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-5">
          <PriceComparison
            cells={[
              { label: 'Today', amount: today, unit: '/mo' },
              { label: 'Frozen', amount: frozen, unit: '/mo' },
            ]}
            footer={{ label: 'You save', value: `${formatUsd(today - frozen)}/mo`, positive: true }}
          />
          <TermList>
            <Term icon={CalendarBlankIcon} title={`Frozen for at least ${MIN_TERM_DAYS} days`}>
              Unfreezing or deleting the bucket earlier charges the rest of the term.
            </Term>
            <Term icon={ClockIcon} title="Restoring takes 1 hour or more">
              Restoring costs {formatUsd(getWarmPeriodPricePerTb())}/TB for 2 weeks, the shortest
              restore.
            </Term>
          </TermList>
          <Alert
            variant="amber"
            assertive={false}
            description="Downloads, backup tools and share links stop working until you restore the bucket. Uploads and deletes are blocked while the bucket is frozen."
          />
        </div>
      </ModalBody>
      <ModalFooter fullWidth>
        <Button id="freeze-bucket-cancel-button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button id="freeze-bucket-confirm-button" variant="primary" onClick={handleFreeze}>
          Freeze bucket
        </Button>
      </ModalFooter>
    </Modal>
  );
}
