import { useState } from 'react';
import { Description } from '@headlessui/react';

import type { S3ObjectVersion, S3Region } from '@filone/shared';

import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { Button } from './Button';
import { FormField } from './FormField';
import { Input } from './Input';
import { RadioOption } from './RadioOption';
import { FactList, type Fact } from './ColdStorageFacts';
import { useToast } from './Toast';
import {
  COLD_PRICE_PER_TB_MONTH,
  MAX_RESTORE_DAYS,
  MIN_TERM_DAYS,
  WARM_MIN_DAYS,
  WARM_PRICE_PER_TB_MONTH,
  formatMoment,
  extendRestores,
  formatRate,
  getMaxExtensionDays,
  isColdFile,
  isInMinimumTerm,
  isValidRestoreDays,
  restoreFiles,
  restorePermanently,
  trackColdStorage,
  useClock,
  useColdFiles,
  useLastNonNull,
} from '../lib/cold-storage-prototype.js';
import { findRuleAbove } from '../lib/cold-storage-files.js';

type RestoreLength = 'period' | 'permanent';

/** What the Add field starts at: a week, since a copy already has its 14 days. */
const EXTEND_DEFAULT_DAYS = 7;

/** One choice of what to restore: a file, the selection, a folder or the whole bucket. */
export interface RestoreScope {
  id: string;
  label: string;
  /**
   * The folder the scope covers, `''` for the whole bucket; absent for picked
   * files. A permanent restore of a folder or the bucket also ends the freeze
   * rules there.
   */
  prefix?: string;
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
 * Confirms a restore: what to restore, and for how long. For a period of time
 * the files get a copy to download for the days chosen, and the originals
 * stay frozen. Permanently, they go back to Standard for good, and for a
 * folder or the bucket the freeze rule there ends, so new uploads stay in
 * Standard. Every scope runs as one job, so a folder or a bucket is one
 * confirmation, not one per file.
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

/** The dialog's words, which turn on whether it adds days or restores, and for how long. */
function describeRestore(
  target: RestoreTarget,
  scope: RestoreScope,
  permanent: boolean,
): { title: string; description: string[]; confirm: string } {
  const files = countFiles(scope.versions.length);
  if (target.extend) {
    return {
      title: `Add days to ${scope.versions.length === 1 ? scope.label : files}`,
      description: ['Keep the copy available for longer.', 'The original stays frozen.'],
      confirm: 'Add days',
    };
  }
  const single = target.scopes.length === 1 && scope.versions.length === 1;
  return {
    title: single ? `Restore ${scope.label}` : `Restore files from ${target.bucketName}`,
    description: permanent
      ? ['The files go back to Standard storage for good.']
      : ['You get a copy to download and share.', 'The originals stay frozen.'],
    confirm: permanent ? `Unfreeze ${files}` : `Restore ${files}`,
  };
}

function RestoreForm({ target, onClose }: { target: RestoreTarget; onClose: () => void }) {
  const { bucketName, region, scopes, extend = false } = target;
  const [scopeId, setScopeId] = useState(scopes[0]?.id);
  const [length, setLength] = useState<RestoreLength>('period');
  const [daysText, setDaysText] = useState(String(extend ? EXTEND_DEFAULT_DAYS : WARM_MIN_DAYS));
  const clock = useClock();
  const cold = useColdFiles(bucketName, region);
  const { toast } = useToast();
  const scope = scopes.find((s) => s.id === scopeId) ?? scopes[0];
  const days = Number(daysText);
  if (!scope) return null;

  // When each copy expires now. Days are only added to files that all have one.
  const expiries = scope.versions.flatMap((version) => {
    const state = cold.getState(version);
    return state.status === 'restored' ? [state.expiresAt] : [];
  });
  // The API takes 1 to 365 days. A new copy is kept and billed for at least
  // 14, so the console offers only the days a customer actually gets. Added
  // days come on top of a copy that has had its 14 already, so one will do.
  const range = extend
    ? { min: 1, max: getMaxExtensionDays(expiries, cold.now, clock) }
    : { min: WARM_MIN_DAYS, max: MAX_RESTORE_DAYS };
  const validDays = isValidRestoreDays(days) && days >= range.min && days <= range.max;

  // Adding days to copies that exist has no permanent side: Unfreeze does that.
  const permanent = !extend && length === 'permanent';
  const period = describePeriod(extend, expiries, validDays ? days : 0, clock);
  const copy = describeRestore(target, scope, permanent);
  const files = countFiles(scope.versions.length);
  const track = (restoreLength: string) =>
    trackColdStorage('restore confirmed', {
      scope: scope.id,
      files: String(scope.versions.length),
      days: restoreLength,
    });

  function handleRestore() {
    if (!scope) return;
    if (permanent) {
      const waiting = restorePermanently(bucketName, region, {
        versions: scope.versions,
        prefix: scope.prefix,
        label: scope.label,
      });
      track('permanent');
      toast.success(
        waiting === 0
          ? `${files} back in Standard`
          : `Restoring ${files}. We’ll email you when they’re back in Standard.`,
      );
    } else if (extend) {
      extendRestores(bucketName, region, { keys: scope.versions.map((v) => v.key), days });
      track(`+${days}`);
      toast.success(period.toast ?? `${days} days added to ${files}`);
    } else {
      restoreFiles(bucketName, region, { versions: scope.versions, days, label: scope.label });
      track(String(days));
      toast.success(`Restoring ${files}. We’ll email you when downloads work.`);
    }
    onClose();
  }

  return (
    <>
      <ModalHeader
        onClose={onClose}
        description={
          // One line per sentence, so a sentence never starts at the end of a line.
          copy.description.map((sentence) => (
            <span key={sentence} className="block">
              {sentence}
            </span>
          ))
        }
      >
        {copy.title}
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
          {!extend && <RestoreLengthField value={length} onChange={setLength} />}
          {permanent ? (
            <PermanentFacts scope={scope} cold={cold} />
          ) : (
            <PeriodFields
              label={period.label}
              range={range}
              daysText={daysText}
              onDaysChange={setDaysText}
              validDays={validDays}
              facts={period.facts}
              footnote={period.footnote}
            />
          )}
        </div>
      </ModalBody>
      <ModalFooter fullWidth>
        <Button id="restore-files-cancel-button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          id="restore-files-confirm-button"
          variant="primary"
          disabled={!permanent && !validDays}
          onClick={handleRestore}
        >
          {copy.confirm}
        </Button>
      </ModalFooter>
    </>
  );
}

function RestoreLengthField({
  value,
  onChange,
}: {
  value: RestoreLength;
  onChange: (value: RestoreLength) => void;
}) {
  // Side by side from `sm`: two short options stacked made the dialog scroll.
  // The header says what each means in full, so the descriptions stay short.
  return (
    <fieldset className="grid gap-2 sm:grid-cols-2">
      <legend className="mb-2 text-sm font-medium text-zinc-900">How long</legend>
      <RadioOption
        name="restore-length"
        value="period"
        checked={value === 'period'}
        onChange={() => onChange('period')}
        description="A copy to download"
      >
        For a period of time
      </RadioOption>
      <RadioOption
        name="restore-length"
        value="permanent"
        checked={value === 'permanent'}
        onChange={() => onChange('permanent')}
        description="Back to Standard"
      >
        Permanently
      </RadioOption>
    </fieldset>
  );
}

/**
 * The words around the days field: what it asks for, what the days give and
 * what the copy bills. `days` is 0 while the field holds no valid number.
 */
function describePeriod(
  extend: boolean,
  expiries: number[],
  days: number,
  clock: { dayMs: number; restoreWaitMs: number },
): { label: string; facts: Fact[]; footnote: string; toast?: string } {
  const rate = `The copy bills at ${formatRate(WARM_PRICE_PER_TB_MONTH)} on top of frozen storage.`;
  if (extend) {
    return { label: 'Add', footnote: rate, ...describeExtension(expiries, days, clock.dayMs) };
  }
  const until = Date.now() + clock.restoreWaitMs + (days || WARM_MIN_DAYS) * clock.dayMs;
  return {
    label: 'Keep the copy for',
    facts: [
      { label: 'Ready in', value: 'About an hour' },
      { label: 'Available until', value: formatMoment(until) },
    ],
    footnote: `We’ll email you when it’s ready. ${rate}`,
  };
}

/**
 * Adding days, as the dialog shows it: the new date with the current one
 * under it, or for copies that expire on different days, how much later each
 * one does. `days` is 0 while the field holds no valid number.
 */
function describeExtension(
  expiries: number[],
  days: number,
  dayMs: number,
): { facts: Fact[]; toast?: string } {
  const distinct = [...new Set(expiries)];
  const [only] = distinct;
  if (distinct.length !== 1 || only === undefined) {
    return {
      facts: [{ label: 'Available until', value: `${days} days later for each copy` }],
    };
  }
  const extended = formatMoment(only + days * dayMs);
  return {
    facts: [
      {
        label: 'Available until',
        value: extended,
        ...(days > 0 ? { detail: `Currently ${formatMoment(only)}` } : {}),
      },
    ],
    toast: `Copy available until ${extended}`,
  };
}

/** A restore for a period of time: the days to keep the copy, or to add to it, and what that gives. */
function PeriodFields({
  label,
  range,
  daysText,
  onDaysChange,
  validDays,
  facts,
  footnote,
}: {
  label: string;
  range: { min: number; max: number };
  daysText: string;
  onDaysChange: (text: string) => void;
  validDays: boolean;
  facts: Fact[];
  footnote: string;
}) {
  return (
    <>
      <FormField
        label={label}
        htmlFor="restore-days"
        error={
          validDays ? undefined : `Enter a whole number of days from ${range.min} to ${range.max}.`
        }
      >
        {/* A few digits need a narrow field, and the range beside it reads on
            from the label as one sentence. A `Description` inside the field
            still registers with the input, so it is announced as before. */}
        <div className="flex items-center gap-2">
          {/* The width sits on a wrapper: `Input` sets `w-full`, which a
              class passed in does not override. */}
          <div className="w-20 shrink-0">
            <Input
              id="restore-days"
              type="number"
              inputMode="numeric"
              min={range.min}
              max={range.max}
              value={daysText}
              onChange={onDaysChange}
              invalid={!validDays}
            />
          </div>
          <Description className="text-xs whitespace-nowrap text-zinc-600">
            days (from {range.min} to {range.max})
          </Description>
        </div>
      </FormField>
      <FactList facts={facts} />
      <p className="text-xs text-(--color-paragraph-text-subtle)">{footnote}</p>
    </>
  );
}

/**
 * What a permanent restore changes: the rate the files move to, whether new
 * uploads freeze, and, as a footnote, the frozen days still billed.
 */
function PermanentFacts({
  scope,
  cold,
}: {
  scope: RestoreScope;
  cold: ReturnType<typeof useColdFiles>;
}) {
  const inTerm = scope.versions.filter((version) => {
    const state = cold.getState(version);
    return isColdFile(state) && isInMinimumTerm(state, cold.now);
  }).length;
  const ruleAbove =
    scope.prefix === undefined
      ? undefined
      : findRuleAbove(cold.record?.policies ?? [], scope.prefix);
  const uploads =
    scope.prefix === undefined
      ? null
      : ruleAbove
        ? `Still freeze, under the rule on ${ruleAbove.prefix === '' ? 'the whole bucket' : ruleAbove.prefix}`
        : 'Stay in Standard';
  const termNote =
    inTerm === 0
      ? 'Freeze them again any time from the file menu.'
      : `${inTerm === scope.versions.length ? 'Every one is' : `${countFiles(inTerm)} are`} inside the ${MIN_TERM_DAYS}-day frozen term, which still bills its remaining days at ${formatRate(COLD_PRICE_PER_TB_MONTH)}.`;
  return (
    <>
      <FactList
        facts={[
          {
            label: 'Storage',
            value: 'Standard',
            detail: formatRate(WARM_PRICE_PER_TB_MONTH),
          },
          ...(uploads ? [{ label: 'New uploads', value: uploads }] : []),
        ]}
      />
      <p className="text-xs text-(--color-paragraph-text-subtle)">{termNote}</p>
    </>
  );
}
