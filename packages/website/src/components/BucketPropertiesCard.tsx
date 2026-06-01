import {
  ClockCounterClockwiseIcon,
  LockIcon,
  LockSimpleIcon,
  QuestionIcon,
  ShieldCheckIcon,
} from '@phosphor-icons/react/dist/ssr';

import type { Bucket } from '@filone/shared';

import { Tooltip } from './Tooltip';

function formatRetention(mode?: string, duration?: number, durationType?: string): string | null {
  if (!mode || !duration || !durationType) return null;
  const unit =
    durationType === 'y' ? (duration === 1 ? 'year' : 'years') : duration === 1 ? 'day' : 'days';
  const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
  return `${modeLabel} · ${duration} ${unit}`;
}

type PropertyCardProps = {
  icon: React.ComponentType<{ size: number; className?: string; 'aria-hidden'?: boolean }>;
  label: string;
  value: string;
  enabled?: boolean;
  tooltip: string;
};

function PropertyCard({ icon: Icon, label, value, enabled, tooltip }: PropertyCardProps) {
  return (
    <div className="flex items-center gap-4 rounded-lg border border-zinc-200 bg-white px-5 py-4">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-zinc-100">
        <Icon size={20} className="text-zinc-500" aria-hidden />
      </div>
      <div>
        <div className="flex items-center gap-1">
          <p className="text-sm font-medium text-zinc-900">{label}</p>
          <Tooltip content={tooltip} side="bottom">
            <QuestionIcon size={13} className="text-zinc-500 hover:text-zinc-700" aria-hidden />
          </Tooltip>
        </div>
        <p
          className={`text-xs font-medium ${
            enabled === true
              ? 'text-green-700'
              : enabled === false
                ? 'text-zinc-400'
                : 'text-zinc-600'
          }`}
        >
          {value}
        </p>
      </div>
    </div>
  );
}

export function BucketPropertyCards({ bucket }: { bucket: Bucket }) {
  return (
    <>
      <PropertyCard
        icon={ClockCounterClockwiseIcon}
        label="Versioning"
        value={bucket.versioning ? 'Enabled' : 'Disabled'}
        enabled={bucket.versioning}
        tooltip="Keeps multiple versions of each object"
      />
      <PropertyCard
        icon={LockIcon}
        label="Object Lock"
        value={bucket.objectLockEnabled ? 'Enabled' : 'Disabled'}
        enabled={bucket.objectLockEnabled}
        tooltip="Prevents deletion or modification during a retention period"
      />
      <PropertyCard
        icon={ShieldCheckIcon}
        label="Encryption"
        value="Enabled"
        enabled={true}
        tooltip="Always on. All data is encrypted at rest."
      />
      {bucket.defaultRetention && (
        <PropertyCard
          icon={LockSimpleIcon}
          label="Default Retention"
          value={
            formatRetention(
              bucket.defaultRetention,
              bucket.retentionDuration,
              bucket.retentionDurationType,
            ) ?? 'N/A'
          }
          tooltip="Default retention policy applied to all new objects uploaded to this bucket."
        />
      )}
    </>
  );
}
