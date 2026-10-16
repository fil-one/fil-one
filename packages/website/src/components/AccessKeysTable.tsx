import { useEffect, useState } from 'react';

import { KeyIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react/dist/ssr';

import { IconBox } from './IconBox';

import type { AccessKey } from '@filone/shared';
import { getRegionLabel } from '@filone/shared';

import {
  BucketSummary,
  keyMenuActions,
  FollowsBucketPolicy,
  KeyStatus,
  KeyTypeBadge,
  PermissionBadges,
} from './AccessKeyCells';
import { AccessKeyDetailsDrawer } from './AccessKeyDetailsDrawer';
import { Button } from './Button';
import { Checkbox } from './Checkbox';
import { CopyButton } from './CopyButton';
import { RegionFlag } from './RegionFlag';
import { RowActionsMenu } from './RowActionsMenu';
import { Table } from './Table/Table';
import { formatDate } from '../lib/time.js';

/**
 * The owner, and beneath them whoever last reissued the credential.
 *
 * The same two-tone split the members roster uses: the person is the value,
 * the address identifies which one. A rotation keeps the owner, so the rotator
 * gets a line of their own rather than the owner's — an Admin who reissued a
 * member's key is named without the key changing hands.
 */
function Attribution({
  accessKey,
  creatorFor,
}: {
  accessKey: AccessKey;
  creatorFor?: (userId: string) => { name: string; email?: string } | undefined;
}) {
  const creator = accessKey.createdBy ? creatorFor?.(accessKey.createdBy) : undefined;
  const rotator = accessKey.rotatedBy ? creatorFor?.(accessKey.rotatedBy) : undefined;
  return (
    <>
      {creator ? (
        <>
          <p className="text-xs text-zinc-700">{creator.name}</p>
          {creator.email && creator.email !== creator.name && (
            <p className="text-xs text-zinc-500">{creator.email}</p>
          )}
        </>
      ) : (
        <span className="text-xs text-zinc-400">—</span>
      )}
      {accessKey.rotatedBy && (
        <p className="text-xs text-zinc-500">
          Rotated{rotator ? ` by ${rotator.name}` : ''}
          {accessKey.rotatedAt ? ` on ${formatDate(accessKey.rotatedAt)}` : ''}
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// AccessKeysTable
// ---------------------------------------------------------------------------

export type AccessKeysTableProps = {
  keys: AccessKey[];
  showRegion?: boolean;
  showBuckets?: boolean;
  showPermissions?: boolean;
  /**
   * Whether the details drawer links each bucket to its page. Left off on a
   * bucket's own access tab, where the link would lead back to the same page.
   */
  linkBuckets?: boolean;
  /**
   * Who minted each key, resolved from a user id. Passed only when the org has
   * somebody else in it: a column reading the same name on every row is noise
   * in an org of one, and it is the column that says which keys leave with a
   * departing member — removal does not revoke them (FIL-1021).
   *
   * A resolver rather than the roster itself, so the table stays presentational
   * and does not learn what a membership is.
   */
  creatorFor?: (userId: string) => { name: string; email?: string } | undefined;
  onDelete?: (id: string) => Promise<void>;
  /** Enables row selection and a bulk-delete toolbar. */
  onBulkDelete?: (ids: string[]) => Promise<void>;
  /**
   * Which rows carry the action. Omitted, every row does — the caller has
   * already decided by passing `onDelete` at all. A Member holds
   * `keys.manage_own`, so the answer is per key rather than per table.
   */
  canDelete?: (key: AccessKey) => boolean;
  /**
   * Reissue the credential and keep the rest of the key. Omitted, the menu
   * carries only Delete, which is what the bucket-scoped table wants.
   */
  onRotate?: (id: string) => void;
  /**
   * Which rows may be rotated. Rotating is a mint, so this is narrower than
   * {@link AccessKeysTableProps.canDelete}: a role that could no longer create
   * the key is refused the replacement, and the caller answers per key.
   */
  canRotate?: (key: AccessKey) => boolean;
  onCreateOpen?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
};

/** The key's name and access key ID, plus its status below `sm`. */
function KeyNameCell({ accessKey: key, onOpen }: { accessKey: AccessKey; onOpen: () => void }) {
  return (
    // `w-0` holds the column to its content, so the table's spare width goes to
    // the columns beside it rather than opening a gap after the copy button.
    <Table.Cell className="w-0">
      {/* Capped at the width of a standard 20-character access key ID, so a
          longer name or ID truncates instead of widening the column; `title`
          and the copy button keep the full value. */}
      <div className="max-w-48">
        {/* The row opens the drawer on a click anywhere, but a row is not a
            control: this button is how a keyboard or screen reader gets there. */}
        {/* Held to the text's 16px line, so the taller badge centres on it
            instead of making a personal key's row taller than its neighbours. */}
        <div className="flex h-4 items-center gap-1.5">
          <button
            type="button"
            onClick={onOpen}
            title={key.keyName}
            className="min-w-0 cursor-pointer truncate rounded-sm text-left text-xs font-medium text-zinc-900 hover:underline focus-visible:brand-outline"
          >
            {key.keyName}
          </button>
          {/* Only the exception is labelled: a service key is the default (the
              only kind outside an `iam` region), so a badge on every row would
              say nothing. The drawer names the type of every key. */}
          {key.type === 'principal' && (
            <span className="shrink-0">
              <KeyTypeBadge type={key.type} />
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <p className="truncate font-mono text-xs text-zinc-500" title={key.accessKeyId}>
            {key.accessKeyId}
          </p>
          <CopyButton value={key.accessKeyId} />
        </div>
      </div>
      {/* Status shown inline on small screens */}
      <div className="mt-1 sm:hidden">
        <KeyStatus accessKey={key} />
      </div>
    </Table.Cell>
  );
}

/** Which optional columns the table shows; the header and every row agree on it. */
interface KeysTableColumns {
  showRegion: boolean;
  showBuckets: boolean;
  showPermissions: boolean;
  showCreatedBy: boolean;
  showActions: boolean;
}

function KeysTableHeader({
  columns,
  selection,
}: {
  columns: KeysTableColumns;
  /** Omitted when the table offers no bulk actions, which drops the checkbox column. */
  selection?: { allSelected: boolean; toggleAll: () => void };
}) {
  return (
    <Table.Header>
      <Table.Row>
        {selection && (
          <Table.Head className="w-0 !pr-0">
            <Checkbox
              checked={selection.allSelected}
              onChange={selection.toggleAll}
              aria-label="Select all keys"
            />
          </Table.Head>
        )}
        <Table.Head>Name</Table.Head>
        {columns.showRegion && <Table.Head className="hidden md:table-cell">Region</Table.Head>}
        {columns.showBuckets && <Table.Head className="hidden lg:table-cell">Buckets</Table.Head>}
        {columns.showPermissions && (
          <Table.Head className="hidden md:table-cell">Permissions</Table.Head>
        )}
        {columns.showCreatedBy && (
          <Table.Head className="hidden lg:table-cell">Created by</Table.Head>
        )}
        <Table.Head className="hidden sm:table-cell">Status</Table.Head>
        {columns.showActions && (
          <Table.Head>
            <span className="sr-only">Actions</span>
          </Table.Head>
        )}
      </Table.Row>
    </Table.Header>
  );
}

/**
 * Whether a click on a row landed on one of its own controls (the checkbox, the
 * copy button, the action menu), which must do their own job rather than open
 * the drawer as well.
 */
function isFromRowControl(target: EventTarget): boolean {
  return (
    target instanceof Element && target.closest('button, a, input, [role="checkbox"]') !== null
  );
}

/** The row's actions, closing the drawer before each runs so its dialog is not stacked under it. */
function closingFirst(
  actions: { onRotate?: () => void; onDelete?: () => void },
  close: () => void,
): { onRotate?: () => void; onDelete?: () => void } {
  const { onRotate, onDelete } = actions;
  return {
    onRotate:
      onRotate &&
      (() => {
        close();
        onRotate();
      }),
    onDelete:
      onDelete &&
      (() => {
        close();
        onDelete();
      }),
  };
}

/** Which rows are checked, dropping any whose key has gone (after a delete, say). */
function useKeySelection(keys: AccessKey[]) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const existing = new Set(keys.map((k) => k.id));
      const next = new Set<string>();
      for (const id of prev) if (existing.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [keys]);

  const allSelected = keys.length > 0 && selected.size === keys.length;
  return {
    selected,
    allSelected,
    toggleAll: () => setSelected(allSelected ? new Set() : new Set(keys.map((k) => k.id))),
    toggleOne: (id: string) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    clearSelection: () => setSelected(new Set()),
  };
}

export function AccessKeysTable({
  keys,
  showRegion = false,
  showBuckets = false,
  showPermissions = false,
  linkBuckets = false,
  creatorFor,
  onDelete,
  onBulkDelete,
  canDelete,
  onRotate,
  canRotate,
  onCreateOpen,
  emptyTitle = 'No API keys yet',
  emptyDescription = 'Generate credentials to connect your applications via S3-compatible API',
}: AccessKeysTableProps) {
  // The header follows the cells: a column whose every row is empty is a column
  // of whitespace with a screen-reader label attached to nothing.
  // The handlers themselves rather than booleans about them: building the
  // closure is where the optional prop narrows, so nothing has to test
  // `onRotate` twice to satisfy both the permission and the compiler.
  const actionsFor = (key: AccessKey) => ({
    onRotate: onRotate && (canRotate?.(key) ?? true) ? () => onRotate(key.id) : undefined,
    onDelete: onDelete && (canDelete?.(key) ?? true) ? () => void onDelete(key.id) : undefined,
  });
  const rowHasAction = (key: AccessKey) => {
    const actions = actionsFor(key);
    return Boolean(actions.onRotate ?? actions.onDelete);
  };
  const showActions = keys.some(rowHasAction);
  // Keys minted before attribution existed carry no `createdBy`, so a column
  // every row would em-dash is one nobody can read anything from. A rotation
  // names its rotator even on such a row, which is something to read.
  const showCreatedBy = Boolean(creatorFor) && keys.some((key) => key.createdBy || key.rotatedBy);

  const selectable = Boolean(onBulkDelete);
  const { selected, allSelected, toggleAll, toggleOne, clearSelection } = useKeySelection(keys);
  const [detailKey, setDetailKey] = useState<AccessKey | null>(null);

  if (keys.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-zinc-200 bg-white px-6 py-16 text-center">
        <IconBox icon={KeyIcon} size="md" color="blue" className="mb-4" />
        <p className="mb-1 text-sm font-medium text-zinc-900">{emptyTitle}</p>
        <p className="mb-4 max-w-xs text-sm text-zinc-500">{emptyDescription}</p>
        {onCreateOpen && (
          <Button variant="primary" icon={PlusIcon} onClick={onCreateOpen}>
            Create your first key
          </Button>
        )}
      </div>
    );
  }

  return (
    <>
      {selectable && selected.size > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2">
          <span className="text-sm text-zinc-600">{selected.size} selected</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={clearSelection}>
              Clear
            </Button>
            <Button
              variant="destructive"
              size="sm"
              icon={TrashIcon}
              onClick={() => void onBulkDelete?.(Array.from(selected))}
            >
              Delete
            </Button>
          </div>
        </div>
      )}
      <Table>
        <KeysTableHeader
          columns={{
            showRegion,
            showBuckets,
            showPermissions,
            showCreatedBy,
            showActions,
          }}
          selection={selectable ? { allSelected, toggleAll } : undefined}
        />
        <Table.Body>
          {keys.map((key) => {
            const isSelected = selected.has(key.id);
            return (
              <Table.Row
                key={key.id}
                data-testid="access-key-row"
                data-access-key-id={key.accessKeyId}
                selected={isSelected}
                className="cursor-pointer"
                onClick={(event) => {
                  if (!isFromRowControl(event.target)) setDetailKey(key);
                }}
              >
                {selectable && (
                  <Table.Cell className="w-0 !pr-0">
                    <Checkbox
                      checked={isSelected}
                      onChange={() => toggleOne(key.id)}
                      aria-label={`Select ${key.keyName}`}
                    />
                  </Table.Cell>
                )}

                {/* Name + Access Key ID */}
                <KeyNameCell accessKey={key} onOpen={() => setDetailKey(key)} />

                {/* Region, laid out as the buckets table lays it out */}
                {showRegion && (
                  <Table.Cell className="hidden text-xs md:table-cell">
                    {key.region ? (
                      <div className="flex items-center gap-2.5">
                        <RegionFlag region={key.region} />
                        <div>
                          <p className="font-medium text-zinc-900">{getRegionLabel(key.region)}</p>
                          <p className="text-zinc-500">{key.region}</p>
                        </div>
                      </div>
                    ) : (
                      <span className="text-zinc-400">-</span>
                    )}
                  </Table.Cell>
                )}

                {/* Buckets */}
                {showBuckets && (
                  <Table.Cell className="hidden lg:table-cell">
                    <BucketSummary accessKey={key} />
                  </Table.Cell>
                )}

                {/* Permissions. A principal-bound key carries none of its own: what
                    it may do follows the bucket policies naming its holder. */}
                {showPermissions && (
                  <Table.Cell className="hidden md:table-cell">
                    {key.type === 'principal' ? (
                      <FollowsBucketPolicy />
                    ) : (
                      <PermissionBadges accessKey={key} onShowDetails={() => setDetailKey(key)} />
                    )}
                  </Table.Cell>
                )}

                {showCreatedBy && (
                  <Table.Cell className="hidden lg:table-cell">
                    <Attribution accessKey={key} creatorFor={creatorFor} />
                  </Table.Cell>
                )}

                {/* Status */}
                <Table.Cell className="hidden sm:table-cell">
                  <KeyStatus accessKey={key} />
                </Table.Cell>

                {/* Actions */}
                {showActions && (
                  <Table.Cell className="text-right">
                    {rowHasAction(key) && (
                      <RowActionsMenu
                        actions={keyMenuActions(actionsFor(key))}
                        aria-label={`Actions for ${key.keyName}`}
                      />
                    )}
                  </Table.Cell>
                )}
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>
      {detailKey && (
        <AccessKeyDetailsDrawer
          accessKey={detailKey}
          creatorFor={creatorFor}
          linkBuckets={linkBuckets}
          onClose={() => setDetailKey(null)}
          {...closingFirst(actionsFor(detailKey), () => setDetailKey(null))}
        />
      )}
    </>
  );
}
