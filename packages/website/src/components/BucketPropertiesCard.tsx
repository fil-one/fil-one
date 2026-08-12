import { useId, useState } from 'react';
import { CaretDownIcon, QuestionIcon } from '@phosphor-icons/react/dist/ssr';

import type { Bucket, BucketAnalyticsResponse } from '@filone/shared';
import { S3_REGION, formatBytes, getRegionLabel } from '@filone/shared';

import { Tooltip } from './Tooltip';
import { formatDate, formatDateTime } from '../lib/time.js';
import { formatRetention } from '../lib/retention.js';

/**
 * The bucket's properties: one uniform line, with configuration behind Details.
 *
 * This page exists to browse objects, and these are short facts about a
 * container. They were four bordered cards with 40px icon tiles, whose fixed
 * three-column grid orphaned the fourth card whenever a bucket had a retention
 * policy.
 *
 * Two rules the earlier attempts broke:
 *
 * - **The line stays uniform.** Every fact is the same size and colour. A
 *   green-dotted chip among plain text read as a different kind of thing and
 *   drew the eye to the least urgent fact on the page.
 * - **Details reveals what the line doesn't say.** Configuration (versioning,
 *   object lock, retention, encryption) lives only there, so opening it is
 *   worth the click. The trigger sits inline at the end of the line, not
 *   right-aligned, where it would stack under the page's primary action and
 *   compete with it.
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
    <div className="mt-1.5 mb-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-zinc-500">
        <span title={region}>{getRegionLabel(region)}</span>

        <Separator />
        {analytics ? (
          <span className="tabular-nums">{formatBytes(analytics.bytesUsed)} used</span>
        ) : (
          // Held rather than shown as "0 B used", which is a different claim.
          <span className="inline-block h-3.5 w-20 animate-pulse rounded bg-zinc-100" />
        )}

        <Separator />
        {/* The date reads here; the exact timestamp is on the title and in the
            panel, since its timezone wrapped a line to say something nobody came
            to this page for. */}
        <span title={formatDateTime(bucket.createdAt)}>Created {formatDate(bucket.createdAt)}</span>

        <Separator />
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-controls={detailsId}
          className="flex items-center gap-1 rounded-sm transition-colors hover:text-zinc-900 focus-visible:brand-outline"
        >
          Details
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
          // Dense label/value rows, not a block per fact. An earlier pass set a
          // sentence of help text under every value, which made six short facts
          // 350px tall and read like a manual.
          className="mt-2.5 grid gap-x-10 gap-y-0.5 rounded-lg border border-zinc-200 bg-white px-4 py-2.5 sm:grid-cols-2 lg:grid-cols-3"
        >
          <Row label="Versioning" hint="Keeps multiple versions of each object">
            <State on={bucket.versioning ?? false} />
          </Row>

          <Row
            label="Object Lock"
            hint="Prevents deletion or modification during a retention period"
          >
            <State on={bucket.objectLockEnabled ?? false} />
          </Row>

          <Row
            label="Retention"
            hint="Applied to objects uploaded from now on; existing objects keep the policy they were uploaded under"
          >
            {retention ?? <span className="text-zinc-400">None</span>}
          </Row>

          <Row label="Encryption">
            <State on />
          </Row>

          <Row label="Created">{formatDateTime(bucket.createdAt)}</Row>

          <Row label="Region">{region}</Row>
        </dl>
      )}
    </div>
  );
}

/**
 * Only where facts share a line. Below `sm` they wrap one per line, and a
 * separator then dangles at the end of a line separating nothing.
 */
function Separator() {
  return (
    <span aria-hidden="true" className="hidden text-zinc-300 sm:inline">
      &bull;
    </span>
  );
}

/**
 * One row: label, then value beside it on a fixed label column.
 *
 * Not `justify-between`: that works in Linear's narrow sidebar, but in a wide
 * three-column grid it throws the value hundreds of pixels from its label and
 * the pair stops reading as a pair.
 */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3 py-1">
      <dt className="flex w-24 shrink-0 items-center gap-1 text-xs text-zinc-500">
        {label}
        {/* Only on the terms that aren't self-evident beside their value, and as a
            question mark rather than a dotted underline: underlined labels read
            like broken links. */}
        {hint && (
          <Tooltip content={hint} side="bottom" focusable label={`About ${label}`}>
            <QuestionIcon size={11} className="text-zinc-400 hover:text-zinc-600" aria-hidden />
          </Tooltip>
        )}
      </dt>
      <dd className="min-w-0 truncate text-xs text-zinc-900">{children}</dd>
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
