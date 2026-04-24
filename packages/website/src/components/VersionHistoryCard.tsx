import { useNavigate } from '@tanstack/react-router';
import { ClockCounterClockwiseIcon } from '@phosphor-icons/react/dist/ssr';
import { formatBytes } from '@filone/shared';
import type { S3ObjectVersion } from '@filone/shared';
import { formatDateTime } from '../lib/time.js';
import { Badge } from './Badge';

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
      <Badge color="red" size="sm" weight="semibold">
        Delete marker
      </Badge>
    );
  }
  if (version.isLatest) {
    return (
      <Badge color="green" size="sm" weight="semibold">
        Latest
      </Badge>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Single version row
// ---------------------------------------------------------------------------

function VersionRow({
  version,
  isCurrent,
  bucketName,
}: {
  version: S3ObjectVersion;
  isCurrent: boolean;
  bucketName: string;
}) {
  const navigate = useNavigate();

  function navigateToVersion() {
    void navigate({
      to: '/buckets/$bucketName/objects',
      params: { bucketName },
      search: { key: version.key, versionId: version.versionId },
    });
  }

  const truncatedId = truncateVersionId(version.versionId, 12);

  return (
    <tr
      className={`border-b border-zinc-100 last:border-0 ${
        isCurrent ? 'bg-brand-50/40' : 'cursor-pointer hover:bg-zinc-50'
      }`}
      onClick={isCurrent ? undefined : navigateToVersion}
      role={isCurrent ? undefined : 'button'}
      tabIndex={isCurrent ? undefined : 0}
      onKeyDown={
        isCurrent
          ? undefined
          : (e) => {
              if (e.key === 'Enter' || e.key === ' ') navigateToVersion();
            }
      }
    >
      <td className="px-3 py-2 font-mono text-zinc-700">
        {truncatedId}
        {isCurrent && (
          <span className="ml-1.5 text-[10px] font-semibold text-brand-600">(viewing)</span>
        )}
      </td>
      <td className="px-3 py-2">
        {version.isDeleteMarker || version.isLatest ? (
          <VersionRowBadge version={version} />
        ) : (
          <span className="text-zinc-400">&mdash;</span>
        )}
      </td>
      <td className="px-3 py-2 text-zinc-600">
        {version.isDeleteMarker ? '\u2014' : formatBytes(version.sizeBytes)}
      </td>
      <td className="px-3 py-2 text-zinc-600">{formatDateTime(version.lastModified)}</td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Main card
// ---------------------------------------------------------------------------

export function VersionHistoryCard({
  versions,
  currentVersionId,
  bucketName,
}: {
  versions: S3ObjectVersion[];
  currentVersionId?: string;
  bucketName: string;
}) {
  if (versions.length <= 1) return null;

  return (
    <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <ClockCounterClockwiseIcon size={14} className="text-zinc-400" aria-hidden="true" />
        <h2 className="text-sm font-medium text-zinc-900">Version history ({versions.length})</h2>
      </div>
      <div className="overflow-hidden rounded-md border border-zinc-200">
        <table className="w-full text-xs">
          <thead className="border-b border-zinc-200 bg-zinc-50">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-zinc-500">Version ID</th>
              <th className="px-3 py-2 text-left font-medium text-zinc-500">Status</th>
              <th className="px-3 py-2 text-left font-medium text-zinc-500">Size</th>
              <th className="px-3 py-2 text-left font-medium text-zinc-500">Last Modified</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <VersionRow
                key={v.versionId}
                version={v}
                isCurrent={v.versionId === currentVersionId}
                bucketName={bucketName}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
