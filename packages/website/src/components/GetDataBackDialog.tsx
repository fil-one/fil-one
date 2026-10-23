import { useRef, useState } from 'react';

import { S3_REGION } from '@filone/shared';

import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { Alert } from './Alert';
import { Button } from './Button';
import { Radio } from './Radio';
import { useToast } from './Toast';
import type { ColdStorageTarget } from './FreezeBucketDialog';
import { CostColumnsHeader, CostRowAmounts, CostRowText, type RowCosts } from './ColdStorageFacts';
import {
  COLD_PRICE_PER_TB_MONTH,
  DAY_MS,
  MIN_TERM_DAYS,
  formatShortDate,
  formatUsd,
  getBillableBytes,
  getMonthlyCost,
  getStandardMonthlyCost,
  getRemainingTermCost,
  getWarmPeriodCost,
  isInMinimumTerm,
  unfreezeBucket,
  useColdStorage,
  warmBucket,
  trackColdStorage,
} from '../lib/cold-storage-prototype.js';

export type GetDataBackChoice = 'warm' | 'unfreeze';

export type GetDataBackTarget = ColdStorageTarget & { preselect: GetDataBackChoice };

type GetDataBackDialogProps = {
  /** The bucket to bring back; `null` closes the dialog. */
  target: GetDataBackTarget | null;
  onClose: () => void;
};

/**
 * One place to get data out of cold storage: both ways in one table, with what
 * each costs now and every month after in columns that mean the same thing for
 * both rows, so choosing "for a while" or "for good" is a straight comparison.
 * A file click preselects the 2-week restore, the usual need.
 */
export function GetDataBackDialog({ target, onClose }: GetDataBackDialogProps) {
  const shown = useRef<GetDataBackTarget>({ bucketName: '', region: S3_REGION, preselect: 'warm' });
  const opened = useRef<GetDataBackTarget | null>(null);
  const [choice, setChoice] = useState<GetDataBackChoice>('warm');
  // Each opening starts from its own preselection, not the last one's.
  if (target && opened.current !== target) {
    opened.current = target;
    shown.current = target;
    setChoice(target.preselect);
  }
  if (!target) opened.current = null;

  const { bucketName, region } = shown.current;
  const state = useColdStorage(bucketName, region);
  const { toast } = useToast();

  if (!state) return null;
  // Already warm: the only way left to go is permanent.
  const canWarm = state.status === 'frozen';
  const selected = canWarm ? choice : 'unfreeze';
  // Priced at the size it was frozen at, not today's analytics.
  const bytes = getBillableBytes(state.bytes);
  const earlyCharge = isInMinimumTerm(state) ? getRemainingTermCost(bytes, state.termEndsAt) : 0;
  const warmCost = getWarmPeriodCost(bytes);
  const standardMonthly = getStandardMonthlyCost(bytes);
  const frozenMonthly = getMonthlyCost(bytes, COLD_PRICE_PER_TB_MONTH);
  const permanentCosts: RowCosts = {
    now: formatUsd(earlyCharge),
    monthly: formatUsd(standardMonthly),
    monthlyNote: `was ${formatUsd(frozenMonthly)}`,
  };
  const termNote =
    earlyCharge > 0
      ? `The one-off charge covers the rest of your ${MIN_TERM_DAYS}-day freeze.`
      : `No one-off charge: your ${MIN_TERM_DAYS}-day minimum has passed.`;

  function handleConfirm() {
    if (!state) return;
    trackColdStorage('data back chosen', {
      choice: selected,
      changedPreselection: String(selected !== shown.current.preselect),
    });
    if (selected === 'warm') {
      warmBucket(bucketName, region, state);
      toast.success('Restoring started. We’ll email you when downloads work.');
    } else {
      unfreezeBucket(bucketName, region, state);
      toast.success('Restoring permanently started. We’ll email you when it’s done.');
    }
    onClose();
  }

  // Number keys pick an option and Enter confirms, unless focus is on a button,
  // where Enter already means that button.
  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === '1' && canWarm) setChoice('warm');
    else if (event.key === '2') setChoice('unfreeze');
    else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      handleConfirm();
    }
  }

  return (
    <Modal open={target !== null} onClose={onClose} size="md" testId="get-data-back-dialog">
      <div onKeyDown={handleKeyDown}>
        <ModalHeader
          onClose={onClose}
          description={
            canWarm
              ? 'Choose how long to restore the data.'
              : 'Move it back to standard storage for good.'
          }
        >
          {canWarm ? `Restore ${bucketName}` : `Restore ${bucketName} permanently`}
        </ModalHeader>
        <ModalBody>
          <CostColumnsHeader />
          {canWarm ? (
            <div
              className="divide-y divide-zinc-200 overflow-hidden rounded-lg border border-zinc-200 text-ui"
              role="radiogroup"
              aria-label="How to restore"
            >
              <OptionRow
                value="warm"
                checked={selected === 'warm'}
                onChange={() => setChoice('warm')}
                title="Restore for 2 weeks"
                description={`Downloadable until ${formatShortDate(Date.now() + 14 * DAY_MS)}, then the restored copy is deleted. Your frozen copy stays untouched.`}
                now={formatUsd(warmCost)}
                monthly={formatUsd(frozenMonthly)}
                monthlyNote="no change"
              />
              <OptionRow
                value="unfreeze"
                checked={selected === 'unfreeze'}
                onChange={() => setChoice('unfreeze')}
                title="Restore permanently"
                description={`Back to standard storage. ${termNote}`}
                {...permanentCosts}
              />
            </div>
          ) : (
            // Already restored, so permanent is the only way left: a plain row,
            // since a lone radio button offers a choice that isn't there.
            <div className="flex items-start gap-3 rounded-lg border border-zinc-200 px-4 py-3 text-ui">
              <span className="flex-1">
                <CostRowText
                  title="Standard storage"
                  description={termNote}
                  costs={permanentCosts}
                />
              </span>
              <CostRowAmounts costs={permanentCosts} />
            </div>
          )}
          {/* After the choice, where it applies to whichever option was picked. */}
          <div className="mt-3">
            <Alert
              variant="grey"
              showIcon={false}
              assertive={false}
              description="Allow at least an hour before your data is available. We’ll email you when it’s ready."
            />
          </div>
        </ModalBody>
        <ModalFooter fullWidth>
          <Button id="get-data-back-cancel-button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button id="get-data-back-confirm-button" variant="primary" onClick={handleConfirm}>
            {selected === 'warm' ? 'Restore for 2 weeks' : 'Restore permanently'}
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  );
}

// Fixed widths, so each amount lines up under its heading across the rows.
/** One option in the table: a radio, what it does, and its Now and Monthly amounts. */
function OptionRow({
  value,
  checked,
  onChange,
  title,
  description,
  now,
  monthly,
  monthlyNote,
}: {
  value: GetDataBackChoice;
  checked: boolean;
  onChange: () => void;
  title: string;
  description: string;
} & RowCosts) {
  const costs = { now, monthly, monthlyNote };
  return (
    <label
      className="flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors duration-150 hover:bg-zinc-50 has-[:checked]:bg-brand-50"
      data-testid={`get-data-back-${value}`}
    >
      <span className="flex flex-1 items-start gap-2.5">
        <Radio
          name="get-data-back"
          value={value}
          checked={checked}
          onChange={onChange}
          className="mt-0.5"
        />
        <CostRowText title={title} description={description} costs={costs} />
      </span>
      <CostRowAmounts costs={costs} />
    </label>
  );
}
