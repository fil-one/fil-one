import { useId, useState } from 'react';
import { CaretDownIcon } from '@phosphor-icons/react/dist/ssr';

import type { Bucket, BucketAnalyticsResponse } from '@filone/shared';
import { S3_REGION, formatBytes, getRegionLabel } from '@filone/shared';

import { RegionFlag } from './RegionFlag';
import { formatDate, formatDateTime } from '../lib/time.js';
import { formatRetention } from '../lib/retention.js';

/**
 * The bucket's properties, as a line rather than a wall.
 *
 * This page exists to browse objects. Four bordered cards with 40px icon tiles
 * spent the top of it on configuration that's read once, and the fixed
 * three-column grid orphaned the fourth card whenever a retention policy
 * existed. What stays inline is what you actually scan (where it is, how big,
 * how old) plus the protection state, which changes what deleting or
 * overwriting an object on this page does. The rest expands on request.
 */
export function BucketProperties({
  bucket,
  analytics,
}: {
  bucket: Bucket;
  analytics: BucketAnalyticsResponse | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();

  const region = bucket.region ?? S3_REGION;
  const retention = formatRetention(
    bucket.defaultRetention,
    bucket.retentionDuration,
    bucket.retentionDurationType,
  );

  return (
    <div className="mt-2 mb-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm sm:gap-x-3">
        <span className="flex items-center gap-2 text-zinc-700">
          <RegionFlag region={region} />
          {getRegionLabel(region)}
        </span>

        <Separator />
        <span className="text-zinc-500 tabular-nums">
          {analytics ? (
            `${formatBytes(analytics.bytesUsed)} used`
          ) : (
            // Held rather than shown as "0 B used", which is a different claim.
            <span className="inline-block h-3.5 w-20 animate-pulse rounded bg-zinc-100" />
          )}
        </span>

        <Separator />
        <span className="text-zinc-500">Created {formatDate(bucket.createdAt)}</span>

        {/* Protection earns its place on the line because it changes what happens
            when you delete or overwrite an object here. Absent when off: "no
            object lock" is the unremarkable case, and a row of "Disabled" chips
            would be noise on every ordinary bucket. */}
        {bucket.versioning && (
          <>
            <Separator />
            <Chip>Versioning</Chip>
          </>
        )}
        {bucket.objectLockEnabled && (
          <>
            <Separator />
            <Chip>Object Lock{retention ? ` · ${retention}` : ''}</Chip>
          </>
        )}

        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-controls={detailsId}
          className="flex items-center gap-1 rounded-sm text-xs text-zinc-500 transition-colors hover:text-zinc-900 focus-visible:brand-outline sm:ml-auto"
        >
          {expanded ? 'Hide details' : 'Details'}
          <CaretDownIcon
            size={11}
            weight="bold"
            aria-hidden="true"
            className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      {expanded && (
        <dl
          id={detailsId}
          // A fixed grid rather than flex-wrap: the property count is constant
          // (retention reads "None" when unset), so three columns divide evenly
          // into two rows and nothing is left stretched across a line of its own.
          className="mt-3 grid gap-x-8 gap-y-5 rounded-lg border border-zinc-200 bg-white px-5 py-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          <Property label="Versioning" hint="Keeps multiple versions of each object">
            <State on={bucket.versioning ?? false} />
          </Property>

          <Property
            label="Object Lock"
            hint="Prevents deletion or modification during a retention period"
          >
            <State on={bucket.objectLockEnabled ?? false} />
          </Property>

          <Property
            label="Default retention"
            hint="Applied to objects uploaded from now on; existing objects keep the policy they were uploaded under"
          >
            {retention ?? <span className="text-zinc-500">None</span>}
          </Property>

          <Property label="Encryption" hint="Always on. All data is encrypted at rest.">
            <State on />
          </Property>

          {/* The full timestamp lives here rather than on the line above, where
              its timezone wrapped to a second row to say something nobody came
              to this page for. */}
          <Property label="Created">{formatDateTime(bucket.createdAt)}</Property>

          <Property label="Region">
            {getRegionLabel(region)} <span className="text-zinc-500">({region})</span>
          </Property>
        </dl>
      )}
    </div>
  );
}

/**
 * Only where items share a line. Below `sm` the facts wrap one per line, and a
 * separator then dangles at the end of a line separating nothing.
 */
function Separator() {
  return (
    <span aria-hidden="true" className="hidden text-zinc-300 sm:inline">
      &bull;
    </span>
  );
}

/** A protection feature that's on. Absent when off, so it never reads as a status field. */
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-zinc-600">
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-green-500" />
      {children}
    </span>
  );
}

/**
 * The hint sits under the value rather than behind a `?` tooltip: in a panel the
 * reader opened deliberately there's room to just say it, and hiding an
 * explanation behind a hover inside a disclosure is one reveal too many.
 */
function Property({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="mt-1 text-sm text-zinc-900">{children}</dd>
      {hint && <p className="mt-1 text-xs leading-relaxed text-zinc-500">{hint}</p>}
    </div>
  );
}

/** On/off state. The dot is the glance, the word is the fact: colour alone would fail WCAG 1.4.1. */
function State({ on }: { on: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={`size-1.5 shrink-0 rounded-full ${on ? 'bg-green-500' : 'bg-zinc-300'}`}
      />
      <span className={on ? 'text-zinc-900' : 'text-zinc-500'}>{on ? 'Enabled' : 'Disabled'}</span>
    </span>
  );
}
