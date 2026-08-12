import { ClockCounterClockwiseIcon, HourglassIcon, LockIcon } from '@phosphor-icons/react/dist/ssr';

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
 * All three always show, even though they're a dependency chain: Object Lock
 * needs versioning, and a retention policy needs Object Lock. The test for
 * whether a property earns a card is whether its value *varies between buckets*,
 * not whether another setting constrains it. These vary, and "Disabled" is a real
 * answer to "is this bucket immutable?" — one nobody should have to infer from
 * the absence of a card plus a memory of S3's prerequisite rules.
 *
 * The prerequisites themselves aren't explained here. All three are fixed at
 * creation, so on a read-only page "requires versioning" is trivia; it belongs in
 * the create-bucket form, where it's something you can act on.
 *
 * "Disabled" for the switches and "None" for retention is deliberate: retention
 * holds a value ("Compliance · 15 days"), not an on/off state, so its absence is
 * "none set" rather than "switched off". They share the same muted weight.
 *
 * Encryption fails that test and isn't shown at all: it's on for every bucket, so
 * saying so per bucket could never tell you anything — the same problem the
 * buckets table's Visibility column had. A product-wide guarantee belongs in the
 * docs, stated once, not repeated on every resource.
 */
export function BucketPropertyCards({ bucket }: { bucket: Bucket }) {
  // "None" rather than the old `?? 'N/A'`, which printed jargon at a bucket that
  // simply has no default policy.
  const retention = formatRetention(
    bucket.defaultRetention,
    bucket.retentionDuration,
    bucket.retentionDurationType,
  );

  return (
    <>
      {/* Three distinct silhouettes. The version this replaced used LockIcon for
          Object Lock and LockSimpleIcon for retention, which at a glance read as
          the same property twice; an hourglass says "a period of time", which is
          what a retention policy is. */}
      <PropertyCard
        icon={ClockCounterClockwiseIcon}
        label="Versioning"
        value={bucket.versioning ? 'Enabled' : 'Disabled'}
        enabled={bucket.versioning}
        tooltip="Keeps multiple versions of each object."
      />
      <PropertyCard
        icon={LockIcon}
        label="Object Lock"
        value={bucket.objectLockEnabled ? 'Enabled' : 'Disabled'}
        enabled={bucket.objectLockEnabled}
        tooltip="Prevents deletion or modification during a retention period."
      />
      <PropertyCard
        icon={HourglassIcon}
        label="Retention"
        value={retention ?? 'None'}
        // "None" is an off state, so it gets the same muted treatment as
        // "Disabled" above; a set policy is protection that's on, so it reads
        // green like the other two. Without this the card defaulted to the
        // neutral colour and "None" looked louder than "Disabled" beside it.
        enabled={Boolean(retention)}
        // Short enough to hold one line under the tooltip's max-w-sm cap; past
        // that, text-balance splits a hint into two even lines.
        tooltip="Applied to every object in this bucket."
      />
    </>
  );
}
