import { Fragment, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowUpIcon,
  CaretDownIcon,
  CaretRightIcon,
  CloudArrowUpIcon,
  DownloadSimpleIcon,
  FileIcon,
  FolderIcon,
  TrashIcon,
} from '@phosphor-icons/react/dist/ssr';

import { formatBytes } from '@filone/shared';
import type { S3ObjectVersion, S3Region } from '@filone/shared';

import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';
import { EmptyStateCard } from './EmptyStateCard';
import { Spinner } from './Spinner';
import { Table } from './Table/Table';
import { VersionRowBadge, truncateVersionId } from './VersionHistoryCard';
import { formatDate } from '../lib/time.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface VersionGroup {
  key: string;
  latest: S3ObjectVersion;
  versions: S3ObjectVersion[];
  versionCount: number;
}

function groupVersionsByKey(versions: S3ObjectVersion[]): VersionGroup[] {
  const groups = new Map<string, S3ObjectVersion[]>();
  for (const v of versions) {
    const existing = groups.get(v.key) ?? [];
    existing.push(v);
    groups.set(v.key, existing);
  }
  return Array.from(groups.entries()).map(([key, vers]) => {
    const latest = vers.find((v) => v.isLatest) ?? vers[0];
    return { key, latest, versions: vers, versionCount: vers.length };
  });
}

type BrowseEntry =
  | { kind: 'folder'; name: string; prefix: string }
  | { kind: 'object'; name: string; group: VersionGroup };

function getEntriesAtPrefix(groups: VersionGroup[], prefix: string): BrowseEntry[] {
  const folders = new Set<string>();
  const files: BrowseEntry[] = [];

  for (const group of groups) {
    if (!group.key.startsWith(prefix)) continue;
    const remainder = group.key.slice(prefix.length);
    const slashIdx = remainder.indexOf('/');
    if (slashIdx === -1) {
      files.push({ kind: 'object', name: remainder, group });
    } else {
      folders.add(remainder.slice(0, slashIdx));
    }
  }

  const folderEntries: BrowseEntry[] = [...folders]
    .sort()
    .map((f) => ({ kind: 'folder', name: f, prefix: `${prefix}${f}/` }));

  files.sort((a, b) => a.name.localeCompare(b.name));

  return [...folderEntries, ...files];
}

// ---------------------------------------------------------------------------
// Row action buttons
// ---------------------------------------------------------------------------

function VersionActions({
  version,
  groupKey,
  downloading,
  onDownload,
  onRequestDelete,
  label,
}: {
  version: S3ObjectVersion;
  groupKey: string;
  downloading: string | null;
  onDownload: (key: string, versionId?: string) => void;
  onRequestDelete: (key: string, versionId: string) => void;
  label: string;
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      {!version.isDeleteMarker && (
        <button
          type="button"
          aria-label={`Download ${label}`}
          onClick={() => onDownload(groupKey, version.versionId)}
          disabled={downloading === groupKey}
          className="text-zinc-400 hover:text-brand-600 disabled:opacity-50"
        >
          {downloading === groupKey ? (
            <Spinner ariaLabel="Downloading" size={16} />
          ) : (
            <DownloadSimpleIcon size={16} aria-hidden="true" />
          )}
        </button>
      )}
      <button
        type="button"
        aria-label={`Delete ${label}`}
        onClick={() => onRequestDelete(groupKey, version.versionId)}
        className="text-zinc-400 hover:text-red-500"
      >
        <TrashIcon size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-row for expanded older versions
// ---------------------------------------------------------------------------

function VersionSubRow({
  version,
  groupKey,
  displayName,
  downloading,
  onDownload,
  onRequestDelete,
  onNavigate,
}: {
  version: S3ObjectVersion;
  groupKey: string;
  displayName: string;
  downloading: string | null;
  onDownload: (key: string, versionId?: string) => void;
  onRequestDelete: (key: string, versionId: string) => void;
  onNavigate: (key: string, versionId: string) => void;
}) {
  return (
    <Table.Row
      className="cursor-pointer bg-zinc-50/50 hover:bg-zinc-100/50"
      role="button"
      tabIndex={0}
      onClick={() => onNavigate(groupKey, version.versionId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onNavigate(groupKey, version.versionId);
      }}
    >
      <Table.Cell className="py-3 pr-4 pl-10">
        <div className="flex items-center gap-2 text-zinc-500">
          <FileIcon size={14} className="shrink-0 text-zinc-300" aria-hidden="true" />
          {displayName}
        </div>
      </Table.Cell>
      <Table.Cell className="font-mono text-xs text-zinc-500" title={version.versionId}>
        {truncateVersionId(version.versionId)}
      </Table.Cell>
      <Table.Cell>
        <VersionRowBadge version={version} />
      </Table.Cell>
      <Table.Cell className="text-zinc-500">
        {version.isDeleteMarker ? '\u2014' : formatBytes(version.sizeBytes)}
      </Table.Cell>
      <Table.Cell className="text-zinc-500">{formatDate(version.lastModified)}</Table.Cell>
      <Table.Cell onClick={(e) => e.stopPropagation()}>
        <VersionActions
          version={version}
          groupKey={groupKey}
          downloading={downloading}
          onDownload={onDownload}
          onRequestDelete={onRequestDelete}
          label={`version ${version.versionId}`}
        />
      </Table.Cell>
    </Table.Row>
  );
}

// ---------------------------------------------------------------------------
// Latest version row (primary row for each object key)
// ---------------------------------------------------------------------------

function LatestVersionRow({
  entry,
  group,
  isExpanded,
  versioningEnabled,
  onToggleExpand,
  downloading,
  onDownload,
  onRequestDelete,
  onNavigate,
}: {
  entry: { name: string };
  group: VersionGroup;
  isExpanded: boolean;
  versioningEnabled: boolean;
  onToggleExpand: (key: string) => void;
  downloading: string | null;
  onDownload: (key: string, versionId?: string) => void;
  onRequestDelete: (key: string, versionId: string) => void;
  onNavigate: (key: string, versionId: string) => void;
}) {
  const hasMultipleVersions = versioningEnabled && group.versionCount > 1;

  return (
    <Table.Row
      className="cursor-pointer"
      role="button"
      tabIndex={0}
      onClick={() => onNavigate(group.key, group.latest.versionId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onNavigate(group.key, group.latest.versionId);
      }}
    >
      <Table.Cell>
        <div className="flex items-center gap-2 font-medium text-zinc-900" title={group.key}>
          {hasMultipleVersions ? (
            <button
              type="button"
              className="shrink-0 text-zinc-400 hover:text-zinc-700"
              aria-label={isExpanded ? 'Collapse versions' : 'Expand versions'}
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand(group.key);
              }}
            >
              {isExpanded ? (
                <CaretDownIcon size={14} aria-hidden="true" />
              ) : (
                <CaretRightIcon size={14} aria-hidden="true" />
              )}
            </button>
          ) : (
            <FileIcon size={16} className="shrink-0 text-zinc-400" aria-hidden="true" />
          )}
          {entry.name}
          {hasMultipleVersions && (
            <span className="ml-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-500">
              {group.versionCount} versions
            </span>
          )}
        </div>
      </Table.Cell>
      {versioningEnabled && (
        <>
          <Table.Cell className="font-mono text-xs text-zinc-500" title={group.latest.versionId}>
            {truncateVersionId(group.latest.versionId)}
          </Table.Cell>
          <Table.Cell>
            <VersionRowBadge version={{ ...group.latest, isLatest: true }} />
          </Table.Cell>
        </>
      )}
      <Table.Cell className="text-zinc-600">
        {group.latest.isDeleteMarker ? '\u2014' : formatBytes(group.latest.sizeBytes)}
      </Table.Cell>
      <Table.Cell className="text-zinc-600">{formatDate(group.latest.lastModified)}</Table.Cell>
      <Table.Cell onClick={(e) => e.stopPropagation()}>
        <VersionActions
          version={group.latest}
          groupKey={group.key}
          downloading={downloading}
          onDownload={onDownload}
          onRequestDelete={onRequestDelete}
          label={entry.name}
        />
      </Table.Cell>
    </Table.Row>
  );
}

// ---------------------------------------------------------------------------
// Prefix breadcrumb
// ---------------------------------------------------------------------------

function PrefixBreadcrumb({
  currentPrefix,
  onPrefixChange,
}: {
  currentPrefix: string;
  onPrefixChange: (prefix: string) => void;
}) {
  return (
    <div className="mb-2 flex items-center gap-1 text-sm">
      <button
        type="button"
        onClick={() => onPrefixChange('')}
        className={`hover:text-brand-600 ${currentPrefix === '' ? 'font-medium text-zinc-900' : 'text-brand-600'}`}
      >
        /
      </button>
      {currentPrefix
        .split('/')
        .filter(Boolean)
        .map((segment, idx, arr) => {
          const segmentPrefix = arr.slice(0, idx + 1).join('/') + '/';
          const isLast = idx === arr.length - 1;
          return (
            <span key={segmentPrefix} className="flex items-center gap-1">
              <span className="text-zinc-400">/</span>
              <button
                type="button"
                onClick={() => onPrefixChange(segmentPrefix)}
                className={`hover:text-brand-600 ${isLast ? 'font-medium text-zinc-900' : 'text-brand-600'}`}
              >
                {segment}
              </button>
            </span>
          );
        })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export type ObjectBrowserProps = {
  bucketName: string;
  region: S3Region;
  versions: S3ObjectVersion[];
  versioningEnabled: boolean;
  currentPrefix: string;
  onPrefixChange: (prefix: string) => void;
  onDownload: (key: string, versionId?: string) => void;
  downloading: string | null;
  onDelete: (key: string, versionId?: string) => Promise<void>;
};

export function ObjectBrowser({
  bucketName,
  region,
  versions,
  versioningEnabled,
  currentPrefix,
  onPrefixChange,
  onDownload,
  downloading,
  onDelete,
}: ObjectBrowserProps) {
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState<{
    key: string;
    versionId?: string;
  } | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  function toggleExpand(key: string) {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function requestDelete(key: string, versionId: string) {
    setConfirmDelete({ key, versionId });
  }

  if (versions.length === 0) {
    return (
      <div className="mt-4">
        <EmptyStateCard
          icon={CloudArrowUpIcon}
          title="No objects yet"
          description="Upload your first object to this bucket"
        >
          <Button
            variant="primary"
            icon={ArrowUpIcon}
            onClick={() =>
              void navigate({
                to: '/buckets/$bucketName/upload',
                params: { bucketName },
                search: { region },
              })
            }
          >
            Upload object
          </Button>
        </EmptyStateCard>
      </div>
    );
  }

  const groups = groupVersionsByKey(versions);
  const entries = getEntriesAtPrefix(groups, currentPrefix);

  function navigateToObject(key: string, versionId: string) {
    void navigate({
      to: '/buckets/$bucketName/objects',
      params: { bucketName },
      search: { key, region, versionId },
    });
  }

  return (
    <div className="mt-4">
      <PrefixBreadcrumb currentPrefix={currentPrefix} onPrefixChange={onPrefixChange} />

      {entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-200 bg-white px-6 py-16 text-center">
          <p className="text-sm text-zinc-500">No objects at this path</p>
        </div>
      ) : (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head>Name</Table.Head>
              {versioningEnabled && (
                <>
                  <Table.Head>Version</Table.Head>
                  <Table.Head>Status</Table.Head>
                </>
              )}
              <Table.Head>Size</Table.Head>
              <Table.Head>Last Modified</Table.Head>
              <Table.Head aria-label="Actions" />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {entries.map((entry) => {
              if (entry.kind === 'folder') {
                return (
                  <Table.Row
                    key={`folder:${entry.prefix}`}
                    className="cursor-pointer"
                    onClick={() => onPrefixChange(entry.prefix)}
                  >
                    <Table.Cell>
                      <div className="flex items-center gap-2 font-medium text-zinc-900">
                        <FolderIcon
                          size={16}
                          className="shrink-0 text-zinc-400"
                          aria-hidden="true"
                        />
                        {entry.name}/
                      </div>
                    </Table.Cell>
                    {versioningEnabled && (
                      <>
                        <Table.Cell className="text-zinc-400">&mdash;</Table.Cell>
                        <Table.Cell className="text-zinc-400">&mdash;</Table.Cell>
                      </>
                    )}
                    <Table.Cell className="text-zinc-400">&mdash;</Table.Cell>
                    <Table.Cell className="text-zinc-400">&mdash;</Table.Cell>
                    <Table.Cell />
                  </Table.Row>
                );
              }

              const { group } = entry;
              const isExpanded = expandedKeys.has(group.key);

              return (
                <Fragment key={`object:${group.key}`}>
                  <LatestVersionRow
                    entry={entry}
                    group={group}
                    isExpanded={isExpanded}
                    versioningEnabled={versioningEnabled}
                    onToggleExpand={toggleExpand}
                    downloading={downloading}
                    onDownload={onDownload}
                    onRequestDelete={requestDelete}
                    onNavigate={navigateToObject}
                  />
                  {isExpanded &&
                    group.versions
                      .filter((v) => v !== group.latest)
                      .map((version) => (
                        <VersionSubRow
                          key={`version:${group.key}:${version.versionId}`}
                          version={version}
                          groupKey={group.key}
                          displayName={entry.name}
                          downloading={downloading}
                          onDownload={onDownload}
                          onRequestDelete={requestDelete}
                          onNavigate={navigateToObject}
                        />
                      ))}
                </Fragment>
              );
            })}
          </Table.Body>
        </Table>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (!confirmDelete) return Promise.resolve();
          return onDelete(confirmDelete.key, confirmDelete.versionId);
        }}
        title="Delete object"
        description="This object will be permanently deleted. This action cannot be undone."
        confirmLabel="Delete"
      />
    </div>
  );
}
