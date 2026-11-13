import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { DatabaseIcon } from '@phosphor-icons/react/dist/ssr';

import type { S3ObjectVersion, S3Region } from '@filone/shared';

import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';
import { ShareObjectModal } from './ShareObjectModal';
import { EmptyStateCard } from './EmptyStateCard';
import { ListingPager, type ListingPagerProps } from './ListingPager';
import { PrefixBreadcrumb } from './ObjectBrowserToolbar';
import { Table } from './Table/Table';
import { FolderRow, ObjectEntryRows, SECONDARY_COLUMN } from './ObjectBrowserRows';
import { BulkActionsBar } from './BulkActionsBar';
import type { RowActions, RowSelection } from './ObjectBrowserRows';
import type { ObjectDeleteTarget } from '../lib/use-object-actions.js';
import type { BrowseEntry } from '../lib/object-grouping.js';
import { getEntriesAtPrefix, groupVersionsByKey } from '../lib/object-grouping.js';
import type { ObjectSelection } from '../lib/object-selection.js';
import { selectionId, useObjectSelection } from '../lib/object-selection.js';
import { useCanShareObjects } from '../lib/use-can-share-objects.js';

export { countObjects } from '../lib/object-grouping.js';

/** No key can reach the bucket yet, and the caller may create one. */
export interface CreateKeyAction {
  kind: 'create';
  onCreate: () => void;
}

/** Keys that reach the bucket already exist, so the step is to use one, not make another. */
export interface ViewKeysAction {
  kind: 'view';
  onView: () => void;
}

export type EmptyBucketKeyAction = CreateKeyAction | ViewKeysAction;

const KEY_ACTION_PHRASES: Record<EmptyBucketKeyAction['kind'], { alone: string; after: string }> = {
  create: {
    alone: 'Create an API key to connect an app to this bucket',
    after: 'create an API key to connect an app',
  },
  view: {
    alone: 'Connect an app to this bucket with an existing API key',
    after: 'connect an app with an existing API key',
  },
};

/** The empty state's line, by which of its two next steps the caller may take. */
function getEmptyBucketDescription(canUpload: boolean, keyAction?: EmptyBucketKeyAction): string {
  const phrases = keyAction && KEY_ACTION_PHRASES[keyAction.kind];
  if (canUpload && phrases) return `Upload files, or ${phrases.after}`;
  if (canUpload) return 'Upload your first object to this bucket';
  if (phrases) return phrases.alone;
  return 'Objects uploaded to this bucket appear here';
}

function EmptyBucketState({
  bucketName,
  region,
  canUpload,
  keyAction,
}: {
  bucketName: string;
  region: S3Region;
  canUpload: boolean;
  keyAction?: EmptyBucketKeyAction;
}) {
  const navigate = useNavigate();
  return (
    <div className="mt-4">
      <EmptyStateCard
        // The sidebar's Buckets icon: it names the thing, and sits evenly over both next steps
        icon={DatabaseIcon}
        title="This bucket is empty"
        description={getEmptyBucketDescription(canUpload, keyAction)}
      >
        {/* Text-only buttons: the bucket icon above sets the scene, and two labelled
            actions side by side read more evenly without glyphs of their own. */}
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
          {keyAction?.kind === 'create' && (
            <Button
              id="object-browser-create-key-button"
              variant={canUpload ? 'ghost' : 'primary'}
              onClick={keyAction.onCreate}
            >
              Create API key
            </Button>
          )}
          {keyAction?.kind === 'view' && (
            <Button
              id="object-browser-view-keys-button"
              variant={canUpload ? 'ghost' : 'primary'}
              onClick={keyAction.onView}
            >
              View API keys
            </Button>
          )}
        </div>
      </EmptyStateCard>
    </div>
  );
}

/** The bulk delete confirmation's title and line, for one item or several. */
function describeBulkDelete(count: number): { title: string; description: string } {
  const one = count === 1;
  return {
    title: `Delete ${count} ${one ? 'item' : 'items'}`,
    description: `${one ? 'This item' : `These ${count} items`} will be permanently deleted. This action cannot be undone.`,
  };
}

/**
 * A listing with no rows in a bucket that has objects: a later page emptied by
 * deletes, or a folder path with nothing in it.
 */
function EmptyListing({ isLaterPage }: { isLaterPage: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-200 bg-white px-6 py-16 text-center">
      <p className="text-sm text-zinc-500">
        {isLaterPage ? 'No objects on this page' : 'No objects at this path'}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Object table
// ---------------------------------------------------------------------------

function ObjectTable({
  entries,
  versioningEnabled,
  expandedKeys,
  onToggleExpand,
  onPrefixChange,
  actions,
  selection,
  rowSelection,
  idsOnPage,
  isPaged,
}: {
  entries: BrowseEntry[];
  versioningEnabled: boolean;
  expandedKeys: Set<string>;
  onToggleExpand: (key: string) => void;
  onPrefixChange: (prefix: string) => void;
  actions: RowActions;
  selection: ObjectSelection;
  rowSelection: RowSelection;
  idsOnPage: string[];
  isPaged: boolean;
}) {
  const allSelected = selection.areAllSelected(idsOnPage);

  return (
    <Table>
      <Table.Header>
        <Table.Row>
          {rowSelection.selectable && (
            <Table.SelectHead
              checked={allSelected}
              onChange={() => selection.setMany(idsOnPage, !allSelected)}
              // A folder spread over pages is selected a page at a time, and
              // the label says so rather than implying the whole folder.
              label={isPaged ? 'Select all objects on this page' : 'Select all objects'}
            />
          )}
          <Table.Head>Name</Table.Head>
          <Table.Head className={SECONDARY_COLUMN}>Size</Table.Head>
          <Table.Head className={SECONDARY_COLUMN}>Last modified</Table.Head>
          <Table.Head aria-label="Actions" />
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {entries.map((entry) => {
          if (entry.kind === 'folder') {
            return (
              <FolderRow
                key={`folder:${entry.prefix}`}
                name={entry.name}
                prefix={entry.prefix}
                onPrefixChange={onPrefixChange}
                selectable={rowSelection.selectable}
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
  /** The API key step the empty state offers beside upload. Absent when there is none to offer. */
  keyAction?: EmptyBucketKeyAction;
  /** Sub-folder prefixes on this page, each ending in '/'. */
  folders: string[];
  /** Previous and next through a folder that spans pages. Absent when it does not. */
  paging?: Omit<ListingPagerProps, 'label'>;
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
  keyAction,
  folders,
  paging,
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

  const groups = groupVersionsByKey(versions);
  const entries = getEntriesAtPrefix(groups, folders, currentPrefix);
  const idsOnPage = entries.flatMap((entry) =>
    entry.kind === 'object' ? [selectionId(entry.group.key, entry.group.latest.versionId)] : [],
  );
  const isPaged = paging !== undefined && (paging.hasPrevious || paging.hasNext);

  // Empty only at the bucket's root on its first page: a later page or a
  // folder with nothing in it is a place in a bucket that has objects.
  const isBucketEmpty = entries.length === 0 && currentPrefix === '' && !paging?.hasPrevious;
  if (isBucketEmpty) {
    return (
      <EmptyBucketState
        bucketName={bucketName}
        region={region}
        canUpload={canUpload}
        keyAction={keyAction}
      />
    );
  }

  return (
    <div className="mt-4">
      {currentPrefix && (
        <PrefixBreadcrumb
          bucketName={bucketName}
          currentPrefix={currentPrefix}
          onPrefixChange={onPrefixChange}
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
        <EmptyListing isLaterPage={paging?.hasPrevious ?? false} />
      ) : (
        <ObjectTable
          entries={entries}
          versioningEnabled={versioningEnabled}
          expandedKeys={expandedKeys}
          onToggleExpand={toggleExpand}
          onPrefixChange={onPrefixChange}
          actions={rowActions}
          selection={selection}
          rowSelection={rowSelection}
          idsOnPage={idsOnPage}
          isPaged={isPaged}
        />
      )}

      {paging && <ListingPager {...paging} label="Object pages" />}

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
        {...describeBulkDelete(selectedCount)}
        confirmLabel="Delete"
      />
    </div>
  );
}
