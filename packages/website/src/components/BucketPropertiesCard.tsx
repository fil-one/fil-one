import {
  ClockCounterClockwiseIcon,
  LockIcon,
  LockSimpleIcon,
  ShieldCheckIcon,
} from '@phosphor-icons/react/dist/ssr';

import type { Bucket } from '@filone/shared';

import { PropertyCard } from './PropertyCard';

function formatRetention(mode?: string, duration?: number, durationType?: string): string | null {
  if (!mode || !duration || !durationType) return null;
  const unit =
    durationType === 'y' ? (duration === 1 ? 'year' : 'years') : duration === 1 ? 'day' : 'days';
  const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
  return `${modeLabel} · ${duration} ${unit}`;
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
