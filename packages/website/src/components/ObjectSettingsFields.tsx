import type { RetentionDurationType, RetentionMode } from '@filone/shared';
import { RETENTION_MAX_DAYS, RETENTION_MAX_YEARS } from '@filone/shared';
import { formatDate } from '../lib/time.js';
import { DurationInput } from './DurationInput';
import { RadioOption } from './RadioOption';
import { Switch } from './Switch';

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
  versioning: boolean;
  onVersioningChange: (value: boolean) => void;
  lock: boolean;
  onLockChange: (value: boolean) => void;
  retentionEnabled: boolean;
  onRetentionEnabledChange: (value: boolean) => void;
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
  versioning,
  onVersioningChange,
  lock,
  onLockChange,
  retentionEnabled,
  onRetentionEnabledChange,
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

  function handleVersioningChange(value: boolean) {
    onVersioningChange(value);
    if (!value) {
      onLockChange(false);
      onRetentionEnabledChange(false);
    }
  }

  function handleLockChange(value: boolean) {
    onLockChange(value);
    if (!value) {
      onRetentionEnabledChange(false);
    }
  }

  return (
    <fieldset className="flex flex-col">
      <legend className="mb-3 text-xs font-medium text-zinc-900">Object settings</legend>

      <div className="overflow-hidden rounded-lg border border-zinc-200">
        {/* Versioning */}
        <div className="flex items-center justify-between px-3.5 py-3">
          <div className="flex flex-col gap-0.5">
            <span id="versioning-label" className="text-[13px] font-medium text-zinc-900">
              Versioning
            </span>
            <span id="versioning-desc" className="text-[11px] leading-relaxed text-zinc-500">
              Keep multiple versions of objects for backup, recovery, and tracking changes over
              time.
            </span>
          </div>
          <Switch
            checked={versioning}
            onChange={handleVersioningChange}
            aria-label="Versioning"
            aria-describedby="versioning-desc"
          />
        </div>

        {/* Object Lock */}
        <div className="border-t border-zinc-200/60">
          <div
            aria-disabled={!versioning}
            className={`flex items-center justify-between px-3.5 py-3 ${!versioning ? 'opacity-40' : ''}`}
          >
            <div className="flex flex-col gap-0.5">
              <span id="lock-label" className="text-[13px] font-medium text-zinc-900">
                Object Lock
              </span>
              <span id="lock-desc" className="text-[11px] leading-relaxed text-zinc-500">
                Prevent objects from being deleted or overwritten. Required for regulatory
                compliance.
              </span>
            </div>
            <Switch
              checked={lock}
              onChange={handleLockChange}
              disabled={!versioning}
              aria-label="Object Lock"
              aria-describedby="lock-desc"
            />
          </div>
        </div>

        {/* Retention */}
        <div className="border-t border-zinc-200/60">
          <div className="flex flex-col px-3.5 py-3">
            <div
              aria-disabled={!lock}
              className={`flex items-center justify-between ${!lock ? 'opacity-40' : ''}`}
            >
              <div className="flex flex-col gap-0.5">
                <span id="retention-label" className="text-[13px] font-medium text-zinc-900">
                  Retention
                </span>
                <span id="retention-desc" className="text-[11px] leading-relaxed text-zinc-500">
                  Apply a default retention period. Objects cannot be deleted until this period
                  expires.
                </span>
              </div>
              <Switch
                checked={retentionEnabled}
                onChange={onRetentionEnabledChange}
                disabled={!lock}
                aria-label="Retention"
                aria-describedby="retention-desc"
              />
            </div>

            {/* Retention details (expanded when enabled) */}
            {retentionEnabled && (
              <div
                className="mt-3 flex flex-col gap-5"
                role="group"
                aria-label="Retention configuration"
              >
                {/* Retention mode */}
                <fieldset className="flex flex-col">
                  <legend className="mb-2.5 text-xs font-medium text-zinc-900">
                    Default Retention Policy
                  </legend>
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
                  <label
                    htmlFor="lock-period-duration"
                    className="text-xs font-medium text-zinc-900"
                  >
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
                      Exceeds your {trialDaysLeft}-day trial period. Objects cannot be deleted until
                      this period expires, but your trial ends before then.
                    </p>
                  ) : trialDaysLeft != null && trialDaysLeft > 0 ? (
                    <p className="text-[11px] text-zinc-500">
                      Objects cannot be deleted until this period expires. Your trial ends in{' '}
                      <span className="font-medium text-zinc-700">{trialDaysLeft} days</span> —
                      retention cannot exceed your remaining trial period.
                    </p>
                  ) : (
                    <p className="text-[11px] text-zinc-500">
                      Objects cannot be deleted until this period expires.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </fieldset>
  );
}
