import type { Bucket } from '@filone/shared';

import { PropertyCard } from './PropertyCard';

function formatRetention(mode?: string, duration?: number, durationType?: string): string | null {
  if (!mode || !duration || !durationType) return null;
  const unit =
    durationType === 'y' ? (duration === 1 ? 'year' : 'years') : duration === 1 ? 'day' : 'days';
  const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
  return `${modeLabel} · ${duration} ${unit}`;
}

/**
 * The bucket's configurable properties, one card each.
 *
 * Encryption isn't here: it's on for every bucket, so a card per bucket saying
 * so is a constant that can't tell you anything — the same problem the buckets
 * table's Visibility column had. It's stated once beside the bucket's other
 * facts instead.
 */
export function BucketPropertyCards({ bucket }: { bucket: Bucket }) {
  // Rendered only when the policy is complete. The old `?? 'N/A'` printed jargon
  // for a partial policy, which is a data problem rather than a value.
  const retention = formatRetention(
    bucket.defaultRetention,
    bucket.retentionDuration,
    bucket.retentionDurationType,
  );

  return (
    <>
      <PropertyCard
        label="Versioning"
        value={bucket.versioning ? 'Enabled' : 'Disabled'}
        enabled={bucket.versioning}
        tooltip="Keeps multiple versions of each object"
      />
      <PropertyCard
        label="Object Lock"
        value={bucket.objectLockEnabled ? 'Enabled' : 'Disabled'}
        enabled={bucket.objectLockEnabled}
        tooltip="Prevents deletion or modification during a retention period"
      />
      {retention && (
        <PropertyCard
          label="Default Retention"
          value={retention}
          tooltip="Default retention policy applied to all new objects uploaded to this bucket."
        />
      )}
    </>
  );
}
