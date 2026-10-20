import { Description, Field } from '@headlessui/react';
import type { RetentionDurationType, RetentionMode } from '@filone/shared';
import { RETENTION_MAX_DAYS, RETENTION_MAX_YEARS } from '@filone/shared';

import { Badge } from './Badge';
import { Input } from './Input';
import { Switch } from './Switch';
import { RadioOption } from './RadioOption';
import { Select } from './Select';

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
    <fieldset className="flex flex-col">
      {/* Named for screen readers only: on the page the Advanced settings toggle above already titles it */}
      <legend className="sr-only">Object settings</legend>

      <div className="overflow-hidden rounded-lg border border-zinc-200">
        {/* Versioning */}
        {/* Each row is a Headless UI Field, so its switch is described by the row's Description
            elements; Headless UI discards an aria-describedby passed to the switch itself */}
        <Field className="flex items-center justify-between gap-8 px-3.5 py-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-ui font-medium text-zinc-900">Versioning</span>
            <Description as="span" className="text-meta leading-relaxed text-zinc-500">
              Keep multiple versions of objects for backup, recovery, and tracking changes over
              time.
            </Description>
          </div>
          <Switch checked={versioning} onChange={handleVersioningChange} aria-label="Versioning" />
        </Field>

        {/* Object Lock */}
        <div className="border-t border-zinc-200/60">
          {/* An unavailable row stays readable: only its switch shows as disabled, and the
              badge, a Description too, says what unlocks it */}
          <Field className="flex items-center justify-between gap-8 px-3.5 py-3">
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="text-ui font-medium text-zinc-900">Object Lock</span>
                {!versioning && (
                  <Description as="span" className="flex">
                    <Badge color="grey" size="xs">
                      Needs Versioning
                    </Badge>
                  </Description>
                )}
              </div>
              <Description as="span" className="text-meta leading-relaxed text-zinc-500">
                Prevent objects from being deleted or overwritten, for regulatory compliance. Can
                only be turned on at creation.
              </Description>
            </div>
            <Switch
              checked={lock}
              onChange={handleLockChange}
              disabled={!versioning}
              aria-label="Object Lock"
            />
          </Field>
        </div>

        {/* Retention */}
        <div className="border-t border-zinc-200/60">
          <div className="flex flex-col px-3.5 py-3">
            <Field className="flex items-center justify-between gap-8">
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-ui font-medium text-zinc-900">Retention</span>
                  {!lock && (
                    <Description as="span" className="flex">
                      <Badge color="grey" size="xs">
                        Needs Object Lock
                      </Badge>
                    </Description>
                  )}
                </div>
                <Description as="span" className="text-meta leading-relaxed text-zinc-500">
                  Apply a default retention period. Objects cannot be deleted until this period
                  expires.
                </Description>
              </div>
              <Switch
                checked={retentionEnabled}
                onChange={onRetentionEnabledChange}
                disabled={!lock}
                aria-label="Retention"
              />
            </Field>

            {/* Retention details (expanded when enabled) */}
            {retentionEnabled && (
              <div
                className="mt-3 flex flex-col gap-3"
                role="group"
                aria-label="Retention configuration"
              >
                {/* Retention mode */}
                <fieldset className="flex flex-col">
                  <legend className="mb-1.5 text-xs font-medium text-zinc-900">
                    Default Retention Policy
                  </legend>
                  <div
                    className="flex flex-col gap-1.5"
                    role="radiogroup"
                    aria-label="Retention mode"
                  >
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
                <Field className="flex flex-col gap-1.5">
                  <label
                    htmlFor="lock-period-duration"
                    className="text-xs font-medium text-zinc-900"
                  >
                    Lock period
                  </label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="lock-period-duration"
                      type="number"
                      min={1}
                      max={retentionDurationType === 'y' ? RETENTION_MAX_YEARS : RETENTION_MAX_DAYS}
                      step={1}
                      value={retentionDuration}
                      onChange={(v) => {
                        const val = parseInt(v, 10);
                        if (!isNaN(val)) onRetentionDurationChange(val);
                      }}
                      className="w-20"
                    />
                    <label htmlFor="lock-period-unit" className="sr-only">
                      Duration unit
                    </label>
                    <div className="w-24">
                      <Select
                        id="lock-period-unit"
                        value={retentionDurationType}
                        onChange={(v) => onRetentionDurationTypeChange(v as RetentionDurationType)}
                      >
                        <option value="d">Days</option>
                        <option value="y">Years</option>
                      </Select>
                    </div>
                  </div>
                  <Description as="span" className="text-meta text-zinc-500">
                    Objects cannot be deleted until this period expires.
                  </Description>
                </Field>
              </div>
            )}
          </div>
        </div>
      </div>
    </fieldset>
  );
}
