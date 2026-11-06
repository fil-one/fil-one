import { LockIcon } from '@phosphor-icons/react/dist/ssr';

import { formatBytes } from '@filone/shared';
import type { ObjectMetadataResponse } from '@filone/shared';

import { Badge } from './Badge';
import { Card } from './Card';
import { CopyButton } from './CopyButton';
import { Heading } from './Heading/Heading';
import { getFileTypeLabel } from '../lib/object-preview.js';
import { formatDate, formatDateTime, timeAgo } from '../lib/time.js';

const retentionDateFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** The date a retention lock lifts, e.g. "Mar 27, 2027". */
export function formatRetainUntil(retainUntilDate: string): string {
  return retentionDateFormat.format(new Date(retainUntilDate));
}

// Past this, "412d ago" says less than the date itself
const RELATIVE_DATE_MAX_DAYS = 30;

/**
 * When the object last changed, relative while that is the useful part ("3d
 * ago") and as a date after it. The exact timestamp is on hover either way.
 */
function formatModified(isoString: string): string {
  const days = (Date.now() - new Date(isoString).getTime()) / 86_400_000;
  return days < RELATIVE_DATE_MAX_DAYS ? timeAgo(isoString) : formatDate(isoString);
}

// User metadata the card shows under its own label, so it is left out of the rest
const NAMED_METADATA_KEYS = new Set(['tags', 'description']);

function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/** The object's facts as label and value pairs, laid out as the access key drawer's are. */
export function ObjectDetailsCard({
  metadata,
  versionId,
  objectLockEnabled,
}: {
  metadata: ObjectMetadataResponse;
  versionId?: string;
  /**
   * Whether the bucket has Object Lock. Without it no object can hold a
   * retention period, so the row would only ever say "None".
   */
  objectLockEnabled: boolean;
}) {
  // Strip surrounding quotes from ETag (S3 returns it wrapped in double-quotes).
  const etag = metadata.etag?.replace(/^"|"$/g, '');
  const tags = parseTags(metadata.metadata.tags);
  const customMetadata = Object.entries(metadata.metadata).filter(
    ([key]) => !NAMED_METADATA_KEYS.has(key),
  );

  return (
    <Card>
      <Heading tag="h2" size="sm" className="mb-4">
        Details
      </Heading>
      <dl className={factGridClass}>
        <Fact label="Size">
          <span title={`${metadata.sizeBytes.toLocaleString()} bytes`}>
            {formatBytes(metadata.sizeBytes)}
          </span>
        </Fact>
        <Fact label="Type">
          {metadata.contentType ? (
            <span title={metadata.contentType}>{getFileTypeLabel(metadata.contentType)}</span>
          ) : (
            <Muted>Unknown</Muted>
          )}
        </Fact>
        <Fact label="Last modified">
          <span title={formatDateTime(metadata.lastModified)}>
            {formatModified(metadata.lastModified)}
          </span>
        </Fact>
        {versionId && (
          <Fact label="Version ID">
            <CopyableValue value={versionId} />
          </Fact>
        )}
        {etag && (
          <Fact label="ETag">
            <CopyableValue value={etag} />
          </Fact>
        )}
        {objectLockEnabled && (
          <Fact label="Retention">
            {metadata.retention ? (
              <span className="inline-flex items-center gap-1.5">
                <LockIcon size={12} aria-hidden="true" className="text-zinc-500" />
                {metadata.retention.mode === 'COMPLIANCE' ? 'Compliance' : 'Governance'}
                <span className="text-zinc-500">
                  until {formatRetainUntil(metadata.retention.retainUntilDate)}
                </span>
              </span>
            ) : (
              <Muted>None</Muted>
            )}
          </Fact>
        )}
        {metadata.metadata.description && (
          <Fact label="Description">{metadata.metadata.description}</Fact>
        )}
        {/* Only when set: the console's upload never sends tags and nothing edits
            them, so for most objects the row could only ever say "None" */}
        {tags.length > 0 && (
          <Fact label="Tags">
            <span className="flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <Badge key={tag} color="grey" size="sm">
                  {tag}
                </Badge>
              ))}
            </span>
          </Fact>
        )}
      </dl>
      {/* The object's own x-amz-meta-* fields, apart from the facts above: their
          keys are the user's, stored lowercase by S3, so they are shown as keys
          (verbatim, in mono) rather than dressed up as labels. */}
      {customMetadata.length > 0 && (
        <div className="mt-4 border-t border-zinc-100 pt-4">
          <Heading tag="h3" size="sm" className="mb-3 text-xs text-zinc-500">
            Custom metadata
          </Heading>
          <dl className={factGridClass}>
            {customMetadata.map(([key, value]) => (
              <Fact key={key} label={key} mono>
                <span className="break-all">{value}</span>
              </Fact>
            ))}
          </dl>
        </div>
      )}
    </Card>
  );
}

// A fixed label column, so the facts and the custom metadata below them line up
// as one table even though they are two lists. Fits "Last modified".
const factGridClass = 'grid grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-x-6 gap-y-3 text-ui';

function Fact({
  label,
  mono,
  children,
}: {
  label: string;
  /** For a key the user chose, shown verbatim rather than as one of the card's labels. */
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className={mono ? 'font-mono text-xs break-all text-zinc-500' : 'text-zinc-500'}>
        {label}
      </dt>
      <dd className="min-w-0 text-zinc-900">{children}</dd>
    </>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-zinc-500">{children}</span>;
}

/** A long identifier: one line, truncated, with the full value on hover and a copy button. */
function CopyableValue({ value }: { value: string }) {
  return (
    // -my-1 keeps the copy button from making this row taller than its neighbours
    <span className="-my-1 flex min-w-0 items-center gap-1">
      <span className="truncate font-mono text-xs text-zinc-700" title={value}>
        {value}
      </span>
      <CopyButton value={value} />
    </span>
  );
}
