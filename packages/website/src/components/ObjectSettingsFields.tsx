import type { RetentionDurationType, RetentionMode } from '@filone/shared';
import { RETENTION_MAX_DAYS, RETENTION_MAX_YEARS } from '@filone/shared';
import { formatDate } from '../lib/time.js';
import { DurationInput } from './DurationInput';
import { RadioOption } from './RadioOption';

function computeExpiryDate(duration: number, type: RetentionDurationType): string {
  const d = new Date();
  if (type === 'y') {
    d.setUTCFullYear(d.getUTCFullYear() + duration);
  } else {
    d.setUTCDate(d.getUTCDate() + duration);
  }
  return formatDate(d.toISOString());
}

const DURATION_UNITS = [
  { value: 'd', label: 'Days' },
  { value: 'y', label: 'Years' },
];

type ObjectSettingsFieldsProps = {
  retentionMode: RetentionMode;
  onRetentionModeChange: (mode: RetentionMode) => void;
  retentionDuration: number;
  onRetentionDurationChange: (value: number) => void;
  retentionDurationType: RetentionDurationType;
  onRetentionDurationTypeChange: (value: RetentionDurationType) => void;
  /** Days remaining in trial, if user is on a trial plan. */
  trialDaysLeft?: number | null;
};

const RETENTION_MODE_OPTIONS: {
  value: RetentionMode;
  label: string;
  description: string;
}[] = [
  {
    value: 'governance',
    label: 'Governance',
    description: 'Users with special permissions can delete or modify protected objects.',
  },
  {
    value: 'compliance',
    label: 'Compliance',
    description: 'No one can delete or modify objects until the retention period expires.',
  },
];

function toDays(duration: number, type: RetentionDurationType): number {
  return type === 'y' ? duration * 365 : duration;
}

export function ObjectSettingsFields({
  retentionMode,
  onRetentionModeChange,
  retentionDuration,
  onRetentionDurationChange,
  retentionDurationType,
  onRetentionDurationTypeChange,
  trialDaysLeft,
}: ObjectSettingsFieldsProps) {
  const maxDuration = retentionDurationType === 'y' ? RETENTION_MAX_YEARS : RETENTION_MAX_DAYS;

  const selectedDays = toDays(retentionDuration, retentionDurationType);
  const exceedsTrial = trialDaysLeft != null && trialDaysLeft > 0 && selectedDays > trialDaysLeft;
  const expiresLabel = `Expires ${computeExpiryDate(retentionDuration, retentionDurationType)}`;

  return (
    <div className="flex flex-col gap-5">
      {/* Retention Policy */}
      <fieldset className="flex flex-col">
        <legend className="mb-2.5 text-xs font-medium text-zinc-900">Retention Policy</legend>
        <div className="flex flex-col gap-1.5">
          {RETENTION_MODE_OPTIONS.map((option) => (
            <RadioOption
              key={option.value}
              name="retention-mode"
              value={option.value}
              checked={retentionMode === option.value}
              onChange={() => onRetentionModeChange(option.value)}
              description={option.description}
            >
              {option.label}
            </RadioOption>
          ))}
        </div>
      </fieldset>

      {/* Lock period */}
      <div className="flex flex-col gap-2.5">
        <label htmlFor="lock-period-duration" className="text-xs font-medium text-zinc-900">
          Lock period
        </label>

        <DurationInput
          numberInputId="lock-period-duration"
          value={retentionDuration}
          onValueChange={onRetentionDurationChange}
          unit={retentionDurationType}
          onUnitChange={(u) => onRetentionDurationTypeChange(u as RetentionDurationType)}
          units={DURATION_UNITS}
          min={1}
          max={maxDuration}
          invalid={exceedsTrial}
          expiresLabel={expiresLabel}
        />

        {exceedsTrial ? (
          <p className="text-[11px] text-amber-600">
            Exceeds your {trialDaysLeft}-day trial period. Objects cannot be deleted until this
            period expires, but your trial ends before then.
          </p>
        ) : trialDaysLeft != null && trialDaysLeft > 0 ? (
          <p className="text-[11px] text-zinc-500">
            Objects cannot be deleted until this period expires. Your trial ends in{' '}
            <span className="font-medium text-zinc-700">{trialDaysLeft} days</span> — retention
            cannot exceed your remaining trial period.
          </p>
        ) : (
          <p className="text-[11px] text-zinc-500">
            Objects cannot be deleted until this period expires.
          </p>
        )}
      </div>
    </div>
  );
}
