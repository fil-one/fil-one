import type { RetentionDurationType, RetentionMode } from '@filone/shared';
import { RETENTION_MAX_DAYS, RETENTION_MAX_YEARS } from '@filone/shared';

import { Switch } from './Switch';

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
}: ObjectSettingsFieldsProps) {
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
    <fieldset className="flex flex-col gap-3.5">
      <legend className="text-xs font-medium text-zinc-900">Object settings</legend>

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
            aria-labelledby="versioning-label"
            aria-describedby="versioning-desc"
          />
        </div>

        {/* Object Lock */}
        <div className="border-t border-zinc-200/60">
          <div
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
              aria-labelledby="lock-label"
              aria-describedby="lock-desc"
            />
          </div>
        </div>

        {/* Retention */}
        <div className="border-t border-zinc-200/60">
          <div className="flex flex-col px-3.5 py-3">
            <div className={`flex items-center justify-between ${!lock ? 'opacity-40' : ''}`}>
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
                aria-labelledby="retention-label"
                aria-describedby="retention-desc"
              />
            </div>

            {/* Retention details (expanded when enabled) */}
            {retentionEnabled && (
              <div
                className="mt-3 flex flex-col gap-3"
                role="group"
                aria-label="Retention configuration"
              >
                {/* Retention mode */}
                <fieldset className="flex flex-col gap-1.5">
                  <legend className="text-xs font-medium text-zinc-900">
                    Default Retention Policy
                  </legend>
                  <div
                    className="flex flex-col gap-1.5"
                    role="radiogroup"
                    aria-label="Retention mode"
                  >
                    {RETENTION_MODE_OPTIONS.map((option) => (
                      <label
                        key={option.value}
                        className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3.5 py-2.5 ${
                          retentionMode === option.value
                            ? 'border-brand-600/40 bg-brand-50/50'
                            : 'border-zinc-200 bg-zinc-50'
                        }`}
                      >
                        <input
                          type="radio"
                          name="retention-mode"
                          value={option.value}
                          checked={retentionMode === option.value}
                          onChange={() => onRetentionModeChange(option.value)}
                          aria-describedby={`retention-mode-${option.value}-desc`}
                          className="accent-brand-600"
                        />
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[13px] font-medium leading-none text-zinc-900">
                            {option.label}
                          </span>
                          <span
                            id={`retention-mode-${option.value}-desc`}
                            className="text-[11px] leading-relaxed text-zinc-500"
                          >
                            {option.description}
                          </span>
                        </div>
                      </label>
                    ))}
                  </div>
                </fieldset>

                {/* Lock period */}
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="lock-period-duration"
                    className="text-xs font-medium text-zinc-900"
                  >
                    Lock period
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id="lock-period-duration"
                      type="number"
                      min={1}
                      max={retentionDurationType === 'y' ? RETENTION_MAX_YEARS : RETENTION_MAX_DAYS}
                      step={1}
                      value={retentionDuration}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10);
                        if (!isNaN(val)) onRetentionDurationChange(val);
                      }}
                      aria-describedby="lock-period-hint"
                      className="w-20 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-[13px] text-zinc-900 focus:outline-2 focus:outline-brand-600"
                    />
                    <label htmlFor="lock-period-unit" className="sr-only">
                      Duration unit
                    </label>
                    <select
                      id="lock-period-unit"
                      value={retentionDurationType}
                      onChange={(e) =>
                        onRetentionDurationTypeChange(e.target.value as RetentionDurationType)
                      }
                      className="w-24 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-[13px] text-zinc-900 focus:outline-2 focus:outline-brand-600"
                    >
                      <option value="d">Days</option>
                      <option value="y">Years</option>
                    </select>
                  </div>
                  <span id="lock-period-hint" className="text-[11px] text-zinc-500">
                    Objects cannot be deleted until this period expires.
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </fieldset>
  );
}
