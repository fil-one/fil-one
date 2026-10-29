import { useNavigate } from '@tanstack/react-router';
import { formatBytes } from '@filone/shared';
import type { S3ObjectVersion, S3Region } from '@filone/shared';
import { formatDateTime } from '../lib/time.js';
import { Badge } from './Badge';
import { Card } from './Card';
import { Heading } from './Heading/Heading';
import { Tooltip } from './Tooltip';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function truncateVersionId(versionId: string, length = 8): string {
  if (versionId.length <= length) return versionId;
  return `${versionId.slice(0, length)}\u2026`;
}

// ---------------------------------------------------------------------------
// Version status badge — row context (shows nothing for historical)
// ---------------------------------------------------------------------------

export function VersionRowBadge({ version }: { version: S3ObjectVersion }) {
  if (version.isDeleteMarker) {
    return (
      <Badge color="red" size="sm">
        Delete marker
      </Badge>
    );
  }
  if (version.isLatest) {
    return (
      <Badge color="green" size="sm">
        Latest
      </Badge>
    );
  }
  return null;
}

/**
 * A delete marker, under S3's own name, which is what the docs and the API use.
 * The term alone reads as an error, or as a version to open, so the tooltip says
 * what it does. Grey, because a deletion here is history, not a problem.
 */
function DeleteMarkerBadge() {
  return (
    <Tooltip
      content="Marks the object as deleted. It hides the object from the bucket, and the versions below it are kept and can still be opened."
      focusable
    >
      <Badge color="grey" size="sm">
        Delete marker
      </Badge>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Single version row
// ---------------------------------------------------------------------------

// Date and time without the time zone: every version shares one, and it is on hover
const versionDateFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** When a version was saved, e.g. "Oct 14, 2026, 6:05 AM", as every version label shows it. */
export function formatVersionDate(isoString: string): string {
  return versionDateFormat.format(new Date(isoString));
}

/**
 * One version: when it was saved leads, since that is how people tell versions
 * apart, with its ID and status beneath; the size sits on the right, in a fixed
 * width so sizes line up down the list.
 */
function VersionRow({
  version,
  isCurrent,
  bucketName,
  region,
}: {
  version: S3ObjectVersion;
  isCurrent: boolean;
  bucketName: string;
  region: S3Region;
}) {
  const navigate = useNavigate();

  function navigateToVersion() {
    void navigate({
      to: '/buckets/$bucketName/objects',
      params: { bucketName },
      // The latest version is the object itself, so it gets the object's own
      // URL rather than a second address that shows the same thing
      search: {
        key: version.key,
        region,
        ...(!version.isLatest && { versionId: version.versionId }),
      },
    });
  }

  // A delete marker has no content to open, so it is a row to read, not a link
  const isLink = !isCurrent && !version.isDeleteMarker;

  const content = (
    <>
      <div className="min-w-0 flex-1">
        <p
          className={version.isDeleteMarker ? 'text-zinc-500' : 'text-zinc-900'}
          title={formatDateTime(version.lastModified)}
        >
          {formatVersionDate(version.lastModified)}
        </p>
        {/* Status rides beside the ID, not in a column of its own, so the date
            above keeps the row's width and stays on one line at 375px */}
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-meta text-zinc-500" title={version.versionId}>
            {truncateVersionId(version.versionId, 16)}
          </span>
          {isCurrent && (
            <Badge color="blue" size="sm">
              Viewing
            </Badge>
          )}
          {version.isDeleteMarker ? <DeleteMarkerBadge /> : <VersionRowBadge version={version} />}
        </div>
      </div>
      <span className="w-16 shrink-0 text-right whitespace-nowrap text-zinc-500 tabular-nums">
        {version.isDeleteMarker ? '' : formatBytes(version.sizeBytes)}
      </span>
    </>
  );

  const rowClass = 'flex w-full items-center gap-3 px-5 py-3 text-left text-ui';
  return (
    <li
      data-testid="version-row"
      data-version-id={version.versionId}
      data-selected={isCurrent ? '' : undefined}
      className={isCurrent ? 'bg-(--color-row-selected)' : undefined}
    >
      {isLink ? (
        <button
          type="button"
          onClick={navigateToVersion}
          // Inset, because the row runs to the card's clipped edges
          className={`${rowClass} cursor-pointer transition-colors duration-150 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:outline-none focus-visible:ring-inset`}
        >
          {content}
        </button>
      ) : (
        <div className={rowClass} aria-current={isCurrent ? 'page' : undefined}>
          {content}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Main card
// ---------------------------------------------------------------------------

/**
 * The object's versions, newest first, as rows straight in the card: a table
 * boxed inside a card nested one bordered surface in another, and at the page's
 * 520px column its four columns wrapped every size and date onto two lines.
 */
export function VersionHistoryCard({
  versions,
  currentVersionId,
  bucketName,
  region,
}: {
  versions: S3ObjectVersion[];
  currentVersionId?: string;
  bucketName: string;
  region: S3Region;
}) {
  if (versions.length <= 1) return null;

  return (
    <Card padding="none" className="overflow-hidden">
      <Heading tag="h2" size="sm" className="px-5 pt-5 pb-3">
        Version history{' '}
        <span className="font-normal text-zinc-400 tabular-nums">{versions.length}</span>
      </Heading>
      <ul className="divide-y divide-zinc-100 border-t border-zinc-100">
        {versions.map((v) => (
          <VersionRow
            key={v.versionId}
            version={v}
            isCurrent={v.versionId === currentVersionId}
            bucketName={bucketName}
            region={region}
          />
        ))}
      </ul>
    </Card>
  );
}
