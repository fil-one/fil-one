import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { CloudArrowUpIcon } from '@phosphor-icons/react/dist/ssr';

import type { S3ObjectVersion, S3Region } from '@filone/shared';

import { Alert } from './Alert';
import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';
import { ShareObjectModal } from './ShareObjectModal';
import { EmptyStateCard } from './EmptyStateCard';
import { Table } from './Table/Table';
import { FolderRow, ObjectEntryRows, SECONDARY_COLUMN } from './ObjectBrowserRows';
import { BulkActionsBar } from './BulkActionsBar';
import type { RowActions, RowSelection } from './ObjectBrowserRows';
import type { ObjectDeleteTarget } from '../lib/use-object-actions.js';
import type { BrowseEntry } from '../lib/object-grouping.js';
import { getEntriesAtPrefix, groupVersionsByKey } from '../lib/object-grouping.js';
import type { ObjectSelection, SelectableVersion } from '../lib/object-selection.js';
import { descendantSelectionIds, useObjectSelection } from '../lib/object-selection.js';
import { useCanShareObjects } from '../lib/use-can-share-objects.js';

export { countObjects } from '../lib/object-grouping.js';

// ---------------------------------------------------------------------------
// Prefix breadcrumb
// ---------------------------------------------------------------------------

function PrefixBreadcrumb({
  bucketName,
  currentPrefix,
  onPrefixChange,
}: {
  bucketName: string;
  currentPrefix: string;
  onPrefixChange: (prefix: string) => void;
}) {
  return (
    <div className="mb-4 flex items-center gap-2 text-sm">
      <button
        type="button"
        onClick={() => onPrefixChange('')}
        className="text-zinc-500 hover:text-zinc-700"
      >
        {bucketName}
      </button>
      {currentPrefix
        .split('/')
        .filter(Boolean)
        .map((segment, idx, arr) => {
          const segmentPrefix = arr.slice(0, idx + 1).join('/') + '/';
          const isLast = idx === arr.length - 1;
          return (
            <span key={segmentPrefix} className="flex items-center gap-2">
              <span className="text-zinc-300">/</span>
              <button
                type="button"
                onClick={() => onPrefixChange(segmentPrefix)}
                className={`hover:text-brand-600 ${isLast ? 'font-medium text-zinc-700' : 'text-brand-600'}`}
              >
                {segment}
              </button>
            </span>
          );
        })}
    </div>
  );
}

/**
 * Shown when the bucket holds more objects than one listing page returns. The
 * count in the tab header comes from analytics and covers the whole bucket, so
 * without this the table silently disagrees with it.
 */
function TruncatedListingNotice({
  loadedCount,
  totalObjectCount,
  selectable,
}: {
  loadedCount: number;
  totalObjectCount?: number;
  selectable: boolean;
}) {
  const total =
    totalObjectCount !== undefined
      ? `${totalObjectCount.toLocaleString()} objects`
      : 'more objects';
  const scope = selectable
    ? ' Selection and delete apply only to the objects listed here.'
    : ' Open a folder to browse the rest.';

  return (
    <div className="mb-3">
      <Alert
        variant="amber"
        title={`Showing the first ${loadedCount.toLocaleString()}`}
        description={`This bucket holds ${total}.${scope}`}
      />
    </div>
  );
}

/** The empty state's line, by which of its two next steps the caller may take. */
function getEmptyBucketDescription(canUpload: boolean, canCreateKey: boolean): string {
  if (canUpload && canCreateKey) {
    return 'Upload files here, or create an API key to connect apps and tools';
  }
  if (canUpload) return 'Upload your first object to this bucket';
  if (canCreateKey) return 'Create an API key to connect apps and tools to this bucket';
  return 'Objects uploaded to this bucket appear here';
}

function EmptyBucketState({
  bucketName,
  region,
  canUpload,
  onCreateKey,
}: {
  bucketName: string;
  region: S3Region;
  canUpload: boolean;
  onCreateKey?: () => void;
}) {
  const navigate = useNavigate();
  return (
    <div className="mt-4">
      <EmptyStateCard
        icon={CloudArrowUpIcon}
        title="No objects yet"
        description={getEmptyBucketDescription(canUpload, Boolean(onCreateKey))}
      >
        {/* Text-only: the cloud tile directly above already speaks "upload",
            so a glyph on the button here would just repeat it. */}
        <div className="flex flex-wrap justify-center gap-2">
          {canUpload && (
            <Button
              id="object-browser-upload-button"
              variant="primary"
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
          )}
          {/* A new bucket lands here, so this is where the create form's API key step moved to */}
          {onCreateKey && (
            <Button
              id="object-browser-create-key-button"
              variant={canUpload ? 'ghost' : 'primary'}
              onClick={onCreateKey}
            >
              Create API key
            </Button>
          )}
        </div>
      </EmptyStateCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Object table
// ---------------------------------------------------------------------------

function ObjectTable({
  entries,
  latestVersions,
  versioningEnabled,
  expandedKeys,
  onToggleExpand,
  onPrefixChange,
  actions,
  selection,
  rowSelection,
  idsAtPrefix,
  listingTruncated,
}: {
  entries: BrowseEntry[];
  latestVersions: SelectableVersion[];
  versioningEnabled: boolean;
  expandedKeys: Set<string>;
  onToggleExpand: (key: string) => void;
  onPrefixChange: (prefix: string) => void;
  actions: RowActions;
  selection: ObjectSelection;
  rowSelection: RowSelection;
  idsAtPrefix: string[];
  listingTruncated: boolean;
}) {
  const allSelected = selection.areAllSelected(idsAtPrefix);

  return (
    <Table>
      <Table.Header>
        <Table.Row>
          {rowSelection.selectable && (
            <Table.SelectHead
              checked={allSelected}
              onChange={() => selection.setMany(idsAtPrefix, !allSelected)}
              label={listingTruncated ? 'Select all loaded objects' : 'Select all objects'}
            />
          )}
          <Table.Head>Name</Table.Head>
          {versioningEnabled && (
            <>
              <Table.Head className={SECONDARY_COLUMN}>Version</Table.Head>
              <Table.Head className={SECONDARY_COLUMN}>Status</Table.Head>
            </>
          )}
          <Table.Head className={SECONDARY_COLUMN}>Size</Table.Head>
          <Table.Head className={SECONDARY_COLUMN}>Last Modified</Table.Head>
          <Table.Head aria-label="Actions" />
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {entries.map((entry) => {
          if (entry.kind === 'folder') {
            const folderIds = descendantSelectionIds(latestVersions, entry.prefix);
            const folderSelected = selection.areAllSelected(folderIds);
            return (
              <FolderRow
                key={`folder:${entry.prefix}`}
                name={entry.name}
                prefix={entry.prefix}
                versioningEnabled={versioningEnabled}
                onPrefixChange={onPrefixChange}
                selectable={rowSelection.selectable}
                isSelected={folderSelected}
                onToggleSelect={() => selection.setMany(folderIds, !folderSelected)}
              />
            );
          }

          return (
            <ObjectEntryRows
              key={`object:${entry.group.key}`}
              name={entry.name}
              group={entry.group}
              isExpanded={expandedKeys.has(entry.group.key)}
              versioningEnabled={versioningEnabled}
              onToggleExpand={onToggleExpand}
              actions={actions}
              selection={rowSelection}
            />
          );
        })}
      </Table.Body>
    </Table>
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
  /** Absent for a role without `objects.delete` — every row drops the control. */
  onDelete?: (key: string, versionId?: string) => Promise<void>;
  /**
   * Enables row selection and a bulk-delete toolbar. Absent for a role without
   * `objects.delete`, which leaves the table with neither.
   */
  onBulkDelete?: (targets: ObjectDeleteTarget[]) => Promise<void>;
  /** Whether to offer the upload route. False for a role without `objects.write`. */
  canUpload?: boolean;
  /** Opens the bucket's Create API key dialog from the empty state. Absent for a role without `keys.create`. */
  onCreateKey?: () => void;
  /**
   * True when the listing is a partial page. Selection can only ever cover the
   * objects actually loaded, so the browser says so rather than implying that
   * "select all" reaches the whole bucket.
   */
  listingTruncated?: boolean;
  /** Full bucket object count from analytics, shown alongside the loaded count. */
  totalObjectCount?: number;
};

/** The share dialog a row's Share button opens, and whether the plan allows it. */
function useRowShare() {
  const canShare = useCanShareObjects();
  // The target outlives `open` so the modal keeps its object while it fades
  // out; the modal resets its own state on close.
  const [target, setTarget] = useState<{ key: string; versionId?: string }>({ key: '' });
  const [open, setOpen] = useState(false);
  return {
    canShare,
    open,
    target,
    request: (key: string, versionId: string) => {
      // An unversioned bucket's rows carry '', which means "the object", not a version.
      setTarget({ key, versionId: versionId || undefined });
      setOpen(true);
    },
    close: () => setOpen(false),
  };
}

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
  onBulkDelete,
  canUpload = true,
  onCreateKey,
  listingTruncated = false,
  totalObjectCount,
}: ObjectBrowserProps) {
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState<{
    key: string;
    versionId?: string;
  } | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const share = useRowShare();
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const selection = useObjectSelection(versions);
  const selectedCount = selection.selected.size;

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

  const rowActions: RowActions = {
    downloading,
    onDownload,
    canShare: share.canShare,
    onShare: share.request,
    // Without a delete handler no row renders the control, so nothing reaches
    // the confirmation dialog below either.
    ...(onDelete && { onRequestDelete: requestDelete }),
    onNavigate: (key, versionId) => {
      void navigate({
        to: '/buckets/$bucketName/objects',
        params: { bucketName },
        search: { key, region, ...(versionId && { versionId }) },
      });
    },
  };

  const rowSelection: RowSelection = {
    selectable: Boolean(onBulkDelete),
    isSelected: (id) => selection.selected.has(id),
    onToggle: selection.toggle,
  };

  if (versions.length === 0) {
    return (
      <EmptyBucketState
        bucketName={bucketName}
        region={region}
        canUpload={canUpload}
        onCreateKey={onCreateKey}
      />
    );
  }

  const groups = groupVersionsByKey(versions);
  const entries = getEntriesAtPrefix(groups, currentPrefix);
  const latestVersions: SelectableVersion[] = groups.map((group) => ({
    key: group.key,
    versionId: group.latest.versionId,
  }));
  const idsAtPrefix = descendantSelectionIds(latestVersions, currentPrefix);

  return (
    <div className="mt-4">
      {currentPrefix && (
        <PrefixBreadcrumb
          bucketName={bucketName}
          currentPrefix={currentPrefix}
          onPrefixChange={onPrefixChange}
        />
      )}

      {listingTruncated && (
        <TruncatedListingNotice
          loadedCount={groups.length}
          totalObjectCount={totalObjectCount}
          selectable={rowSelection.selectable}
        />
      )}

      {rowSelection.selectable && selectedCount > 0 && (
        <BulkActionsBar
          count={selectedCount}
          onClear={selection.clear}
          onDelete={() => setConfirmBulkDelete(true)}
          deleteButtonId="object-browser-bulk-delete-button"
        />
      )}

      {entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-200 bg-white px-6 py-16 text-center">
          <p className="text-sm text-zinc-500">No objects at this path</p>
        </div>
      ) : (
        <ObjectTable
          entries={entries}
          latestVersions={latestVersions}
          versioningEnabled={versioningEnabled}
          expandedKeys={expandedKeys}
          onToggleExpand={toggleExpand}
          onPrefixChange={onPrefixChange}
          actions={rowActions}
          selection={selection}
          rowSelection={rowSelection}
          idsAtPrefix={idsAtPrefix}
          listingTruncated={listingTruncated}
        />
      )}

      <ShareObjectModal
        open={share.open}
        onClose={share.close}
        bucketName={bucketName}
        region={region}
        objectKey={share.target.key}
        versionId={share.target.versionId}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (!confirmDelete || !onDelete) return Promise.resolve();
          return onDelete(confirmDelete.key, confirmDelete.versionId);
        }}
        title="Delete object"
        description="This object will be permanently deleted. This action cannot be undone."
        confirmLabel="Delete"
      />

      <ConfirmDialog
        open={confirmBulkDelete}
        onClose={() => setConfirmBulkDelete(false)}
        onConfirm={async () => {
          await onBulkDelete?.(selection.targets());
          selection.clear();
        }}
        title={`Delete ${selectedCount} ${selectedCount === 1 ? 'item' : 'items'}`}
        description={`${selectedCount === 1 ? 'This item' : `These ${selectedCount} items`} will be permanently deleted. This action cannot be undone.`}
        confirmLabel="Delete"
      />
    </div>
  );
}
