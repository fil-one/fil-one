import { useNavigate } from '@tanstack/react-router';
import { ClockCounterClockwiseIcon } from '@phosphor-icons/react/dist/ssr';
import { formatBytes } from '@filone/shared';
import type { S3ObjectVersion } from '@filone/shared';
import { formatDateTime } from '../lib/time.js';

// ---------------------------------------------------------------------------
// Version status badge (for header area)
// ---------------------------------------------------------------------------

export function VersionBadge({
  versions,
  versionId,
}: {
  versions: S3ObjectVersion[];
  versionId?: string;
}) {
  const current = versions.find((v) => v.versionId === versionId);
  if (!current) return null;

  if (current.isDeleteMarker) {
    return (
      <span className="rounded-full bg-red-50 px-2.5 py-0.5 text-[11px] font-semibold text-red-600">
        Delete marker
      </span>
    );
  }
  if (current.isLatest) {
    return (
      <span className="rounded-full bg-green-50 px-2.5 py-0.5 text-[11px] font-semibold text-green-600">
        Latest version
      </span>
    );
  }
  return (
    <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-600">
      Historical version
    </span>
  );
}

// ---------------------------------------------------------------------------
// Status cell content
// ---------------------------------------------------------------------------

function VersionStatusCell({ version }: { version: S3ObjectVersion }) {
  if (version.isDeleteMarker) {
    return (
      <span className="rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-600">
        Delete marker
      </span>
    );
  }
  if (version.isLatest) {
    return (
      <span className="rounded-full bg-green-50 px-1.5 py-0.5 text-[10px] font-semibold text-green-600">
        Latest
      </span>
    );
  }
  return <span className="text-zinc-400">&mdash;</span>;
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

  const truncatedId =
    version.versionId.length > 12 ? `${version.versionId.slice(0, 12)}\u2026` : version.versionId;

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
        <VersionStatusCell version={version} />
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
