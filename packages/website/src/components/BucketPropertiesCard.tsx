import { ClockCounterClockwiseIcon, HourglassIcon, LockIcon } from '@phosphor-icons/react/dist/ssr';

import type { BucketDetails } from '@filone/shared';

import { PropertyCard } from './PropertyCard';
import { formatRetention } from '../lib/retention.js';

/**
 * The bucket's data protection settings that are on, one card each. An off
 * setting changes nothing about how the bucket behaves, so it gets no card;
 * every setting, on or off, is listed in the Bucket details drawer, which is
 * where "is versioning on?" gets its answer either way.
 *
 * All three are fixed at creation, so their prerequisites (Object Lock needs
 * versioning, retention needs Object Lock) aren't explained here; that belongs
 * in the create-bucket form, where it can be acted on.
 *
 * Encryption isn't shown at all: it's on for every bucket, so saying so per
 * bucket could never tell you anything. A product-wide guarantee belongs in
 * the docs, stated once, not repeated on every resource.
 */
export function BucketPropertyCards({ bucket }: { bucket: BucketDetails }) {
  if (!hasBucketPropertyOn(bucket)) return null;
  const retention = formatRetention(
    bucket.defaultRetention,
    bucket.retentionDuration,
    bucket.retentionDurationType,
  );

  return (
    <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {/* Three distinct silhouettes. The version this replaced used LockIcon for
          Object Lock and LockSimpleIcon for retention, which at a glance read as
          the same property twice; an hourglass says "a period of time", which is
          what a retention policy is. */}
      {bucket.versioning && (
        <PropertyCard
          icon={ClockCounterClockwiseIcon}
          label="Versioning"
          value="Enabled"
          enabled
          tooltip="Keeps multiple versions of each object."
        />
      )}
      {bucket.objectLockEnabled && (
        <PropertyCard
          icon={LockIcon}
          label="Object Lock"
          value="Enabled"
          enabled
          tooltip="Prevents deletion or modification during a retention period."
        />
      )}
      {retention && (
        <PropertyCard
          icon={HourglassIcon}
          label="Retention"
          value={retention}
          enabled
          // Says what retention is, like its neighbours, and "new" because a
          // bucket's default retention locks objects written after it is set,
          // not the ones already there. Past the tooltip's max-w-sm cap,
          // text-balance splits a hint into two even lines.
          tooltip="How long new objects stay protected from deletion or changes."
        />
      )}
    </div>
  );
}

/** Whether any data protection setting is on, which is when the cards show at all. */
export function hasBucketPropertyOn(bucket: BucketDetails): boolean {
  return Boolean(bucket.versioning || bucket.objectLockEnabled || bucket.defaultRetention);
}
