import { useState } from 'react';

import type { S3ObjectVersion, S3Region } from '@filone/shared';

import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { Button } from './Button';
import { FormField } from './FormField';
import { Input } from './Input';
import { RadioOption } from './RadioOption';
import { FactList } from './ColdStorageFacts';
import { useToast } from './Toast';
import {
  MAX_RESTORE_DAYS,
  WARM_MIN_DAYS,
  WARM_PRICE_PER_TB_MONTH,
  formatMoment,
  formatRate,
  isValidRestoreDays,
  restoreFiles,
  trackColdStorage,
  useClock,
  useLastNonNull,
} from '../lib/cold-storage-prototype.js';

/** One choice of what to restore: a file, the selection, a folder or the whole bucket. */
export interface RestoreScope {
  id: string;
  label: string;
  /** The frozen and restored files in the scope; restored ones get their copy extended. */
  versions: S3ObjectVersion[];
}

export interface RestoreTarget {
  bucketName: string;
  region: S3Region;
  /** Narrowest first; the first is chosen when the dialog opens. */
  scopes: RestoreScope[];
  /** Every file already has a copy, so this adds days rather than starting a restore. */
  extend?: boolean;
}

function countFiles(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'file' : 'files'}`;
}

/**
 * Confirms a restore: what to restore, for how many days, when downloads
 * work and until when, with billing as a footnote. Every scope runs as one
 * restore job, so a folder or a bucket is one confirmation, not one per file.
 */
export function RestoreFilesDialog({
  target,
  onClose,
}: {
  target: RestoreTarget | null;
  onClose: () => void;
}) {
  const shown = useLastNonNull(target);
  return (
    <Modal open={target !== null} onClose={onClose} size="sm" testId="restore-files-dialog">
      {shown && (
        // Keyed so each opening starts from its own first scope and 14 days.
        <RestoreForm key={shown.scopes.map((s) => s.id).join()} target={shown} onClose={onClose} />
      )}
    </Modal>
  );
}

function RestoreForm({ target, onClose }: { target: RestoreTarget; onClose: () => void }) {
  const { bucketName, region, scopes, extend = false } = target;
  const [scopeId, setScopeId] = useState(scopes[0]?.id);
  const [daysText, setDaysText] = useState(String(WARM_MIN_DAYS));
  const clock = useClock();
  const { toast } = useToast();
  const scope = scopes.find((s) => s.id === scopeId) ?? scopes[0];
  const days = Number(daysText);
  // The API takes 1 to 365 days, but anything under 14 is kept and billed for
  // 14, so the console only offers the days a customer actually gets.
  const validDays = isValidRestoreDays(days) && days >= WARM_MIN_DAYS;
  if (!scope) return null;

  const readyAt = Date.now() + clock.restoreWaitMs;
  const until = readyAt + (validDays ? days : WARM_MIN_DAYS) * clock.dayMs;

  function handleRestore() {
    if (!scope || !validDays) return;
    restoreFiles(bucketName, region, { versions: scope.versions, days, label: scope.label });
    trackColdStorage('restore confirmed', {
      scope: scope.id,
      files: String(scope.versions.length),
      days: String(days),
    });
    toast.success(
      extend
        ? `Copy available until ${formatMoment(until)}`
        : `Restoring ${countFiles(scope.versions.length)}. We’ll email you when downloads work.`,
    );
    onClose();
  }

  return (
    <>
      <ModalHeader
        onClose={onClose}
        description={
          extend
            ? 'Keep the copy available for longer. The original stays frozen.'
            : 'You get a copy to download and share. The originals stay frozen.'
        }
      >
        {extend
          ? `Add days to ${scope.versions.length === 1 ? scope.label : countFiles(scope.versions.length)}`
          : scopes.length === 1 && scope.versions.length === 1
            ? `Restore ${scope.label}`
            : `Restore files from ${bucketName}`}
      </ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-4">
          {scopes.length > 1 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium text-zinc-900">What to restore</legend>
              {scopes.map((option) => (
                <RadioOption
                  key={option.id}
                  name="restore-scope"
                  value={option.id}
                  checked={option.id === scope.id}
                  onChange={() => setScopeId(option.id)}
                  description={countFiles(option.versions.length)}
                >
                  {option.label}
                </RadioOption>
              ))}
            </fieldset>
          )}
          <FormField
            label="Keep the copy for"
            htmlFor="restore-days"
            description={`Days, from ${WARM_MIN_DAYS} to ${MAX_RESTORE_DAYS}.`}
            error={
              validDays
                ? undefined
                : `Enter a whole number of days from ${WARM_MIN_DAYS} to ${MAX_RESTORE_DAYS}.`
            }
          >
            <Input
              id="restore-days"
              type="number"
              inputMode="numeric"
              min={WARM_MIN_DAYS}
              max={MAX_RESTORE_DAYS}
              value={daysText}
              onChange={setDaysText}
              invalid={!validDays}
            />
          </FormField>
          <FactList
            facts={[
              // An extension adds days to a copy that is already there.
              ...(extend ? [] : [{ label: 'Ready in', value: 'About an hour' }]),
              { label: 'Available until', value: formatMoment(until) },
            ]}
          />
          <p className="text-xs text-(--color-paragraph-text-subtle)">
            {extend ? '' : 'We’ll email you when it’s ready. '}The copy bills at{' '}
            {formatRate(WARM_PRICE_PER_TB_MONTH)} on top of frozen storage.
          </p>
        </div>
      </ModalBody>
      <ModalFooter fullWidth>
        <Button id="restore-files-cancel-button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          id="restore-files-confirm-button"
          variant="primary"
          disabled={!validDays}
          onClick={handleRestore}
        >
          {extend ? 'Add days' : `Restore ${countFiles(scope.versions.length)}`}
        </Button>
      </ModalFooter>
    </>
  );
}
