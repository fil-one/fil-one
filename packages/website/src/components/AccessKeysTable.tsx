import { useEffect, useRef, useState } from 'react';

import {
  ArrowsClockwiseIcon,
  DotsThreeIcon,
  KeyIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react/dist/ssr';

import { IconBox } from './IconBox';

import type { AccessKey, ServiceAccessKey } from '@filone/shared';
import { isBucketInfoPermission, isBucketPermission } from '@filone/shared';

import { AccessKeyPermissionsDrawer } from './AccessKeyPermissionsDrawer';
import { Badge } from './Badge';
import { Button } from './Button';
import { Checkbox } from './Checkbox';
import { CopyButton } from './CopyButton';
import { IconButton } from './IconButton';
import { OverflowBadge } from './OverflowBadge';
import { Table } from './Table/Table';
import { PERMISSION_OPTIONS } from '../lib/access-key-permission-options.js';
import { formatCalendarDate, formatDate } from '../lib/time.js';

/** Active, or Expired with the date it stopped working. */
function KeyStatus({ accessKey }: { accessKey: AccessKey }) {
  if (accessKey.status === 'active') {
    return (
      <Badge color="green" dot size="sm" weight="medium">
        Active
      </Badge>
    );
  }
  return (
    <div className="flex flex-col items-start gap-0.5">
      <Badge color="grey" dot size="sm" weight="medium">
        Expired
      </Badge>
      {accessKey.expiresAt && (
        <p className="text-xs text-zinc-500">{formatCalendarDate(accessKey.expiresAt)}</p>
      )}
    </div>
  );
}

const KEY_TYPE_LABELS: Record<AccessKey['type'], string> = {
  principal: 'Personal',
  service: 'Service',
};

function KeyTypeBadge({ type }: { type: AccessKey['type'] }) {
  return (
    <Badge color="grey" size="sm" data-key-type={type}>
      {KEY_TYPE_LABELS[type]}
    </Badge>
  );
}

/**
 * The object permissions as plain, static facts — scannable across many rows
 * at once, nothing to click, nothing to guess about. Whatever else the key
 * carries (data-protection extras, bucket management, bucket info) is real
 * detail that a chip has no room to be honest about, so one "+N" opens the
 * drawer instead of trying to cram it in here too.
 */
function PermissionBadges({
  accessKey,
  onShowDetails,
}: {
  accessKey: ServiceAccessKey;
  onShowDetails: () => void;
}) {
  // PERMISSION_OPTIONS' order, not the array's — same reason the drawer uses
  // it: Read/Write/List/Delete read in a fixed order everywhere else.
  const permissions = accessKey.permissions ?? [];
  const objectPermissions = PERMISSION_OPTIONS.filter((o) => permissions.includes(o.value));
  const bucketManagement = permissions.filter(isBucketPermission);
  const bucketInfo = permissions.filter(isBucketInfoPermission);
  const extraCount =
    (accessKey.granularPermissions?.length ?? 0) + bucketManagement.length + bucketInfo.length;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {objectPermissions.map((option) => (
        <Badge
          key={option.value}
          color="blue"
          size="sm"
          data-testid={`permission-badge-${option.value}`}
        >
          {option.label}
        </Badge>
      ))}
      {extraCount > 0 && (
        <button
          type="button"
          data-testid="permission-badge-details"
          onClick={onShowDetails}
          className="cursor-pointer rounded-full focus-visible:brand-outline focus-visible:outline-offset-1"
        >
          <Badge color="grey" size="sm">
            +{extraCount} more
          </Badge>
        </button>
      )}
    </div>
  );
}

const BUCKET_BADGES_INLINE_MAX = 3;

function BucketBadges({
  scope,
  buckets,
}: {
  scope: ServiceAccessKey['bucketScope'];
  buckets: string[];
}) {
  if (scope === 'all') {
    return (
      <Badge color="grey" size="sm">
        All Buckets
      </Badge>
    );
  }

  if (buckets.length === 0) {
    return <span className="text-zinc-400">-</span>;
  }

  // Small overflows fit inline for free — collapsing behind a "+1" would cost
  // a click to save no space at all. Only fall back to the popover once there
  // is genuinely more than a glance can take in.
  const shown = buckets.slice(0, BUCKET_BADGES_INLINE_MAX);
  const rest = buckets.slice(BUCKET_BADGES_INLINE_MAX);

  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((bucket) => (
        <Badge key={bucket} color="grey" size="sm">
          {bucket}
        </Badge>
      ))}
      {rest.length > 0 && (
        <OverflowBadge
          label={`+${rest.length}`}
          testId="bucket-badge-overflow"
          sections={[{ items: rest.map((b) => ({ key: b, label: b })) }]}
        />
      )}
    </div>
  );
}

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

function ActionMenu({ onRotate, onDelete }: { onRotate?: () => void; onDelete?: () => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  function handleOpen() {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setOpen((o) => !o);
  }

  return (
    <div className="relative inline-block">
      <IconButton
        ref={buttonRef}
        icon={DotsThreeIcon}
        aria-label="Key actions"
        size="md"
        onClick={handleOpen}
      />
      {open && (
        <div
          ref={menuRef}
          style={{ top: pos.top, right: pos.right }}
          className="fixed z-50 w-40 rounded-lg border border-zinc-200 bg-white py-1 shadow-md"
        >
          {onRotate && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onRotate();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 focus-visible:brand-outline focus-visible:outline-offset-[-2px] active:bg-zinc-100"
            >
              <ArrowsClockwiseIcon size={14} />
              Rotate
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 focus-visible:brand-outline focus-visible:outline-offset-[-2px] active:bg-red-100"
            >
              <TrashIcon size={14} />
              Delete
            </button>
          )}
        </div>
      )}
    </div>
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
  showCreated?: boolean;
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
  showCreated = false,
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
  const [detailKey, setDetailKey] = useState<ServiceAccessKey | null>(null);

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
        <Table.Header>
          <Table.Row>
            {selectable && (
              <Table.Head className="w-0 !pr-0">
                <Checkbox checked={allSelected} onChange={toggleAll} aria-label="Select all keys" />
              </Table.Head>
            )}
            <Table.Head>Name</Table.Head>
            <Table.Head className="hidden sm:table-cell">Type</Table.Head>
            {showRegion && <Table.Head className="hidden md:table-cell">Region</Table.Head>}
            {showBuckets && <Table.Head className="hidden lg:table-cell">Buckets</Table.Head>}
            {showPermissions && (
              <Table.Head className="hidden md:table-cell">Permissions</Table.Head>
            )}
            {showCreatedBy && <Table.Head className="hidden lg:table-cell">Created by</Table.Head>}
            <Table.Head className="hidden sm:table-cell">Status</Table.Head>
            {showCreated && <Table.Head className="hidden lg:table-cell">Created</Table.Head>}
            {showActions && (
              <Table.Head>
                <span className="sr-only">Actions</span>
              </Table.Head>
            )}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {keys.map((key) => {
            const isSelected = selected.has(key.id);
            return (
              <Table.Row
                key={key.id}
                data-testid="access-key-row"
                data-access-key-id={key.accessKeyId}
                className={isSelected ? 'bg-brand-50/40' : undefined}
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
                <Table.Cell>
                  <p className="text-xs font-medium text-zinc-900">{key.keyName}</p>
                  <div className="flex items-center gap-1">
                    <p className="font-mono text-xs text-zinc-500">{key.accessKeyId}</p>
                    <CopyButton value={key.accessKeyId} />
                  </div>
                  {/* Type and status shown inline on small screens */}
                  <div className="mt-1 flex items-start gap-1 sm:hidden">
                    <KeyTypeBadge type={key.type} />
                    <KeyStatus accessKey={key} />
                  </div>
                </Table.Cell>

                <Table.Cell className="hidden sm:table-cell">
                  <KeyTypeBadge type={key.type} />
                </Table.Cell>

                {/* Region — the code a caller configures their SDK with, not
                    the marketing name: this table is for a technical audience. */}
                {showRegion && (
                  <Table.Cell className="hidden font-mono text-xs text-zinc-500 md:table-cell">
                    {key.region ?? '—'}
                  </Table.Cell>
                )}

                {/* Buckets */}
                {showBuckets && (
                  <Table.Cell className="hidden lg:table-cell">
                    {key.type === 'principal' ? (
                      <Badge
                        color="grey"
                        size="sm"
                        description="Buckets whose policy grants this key's owner access."
                      >
                        Per bucket policy
                      </Badge>
                    ) : (
                      <BucketBadges scope={key.bucketScope} buckets={key.buckets ?? []} />
                    )}
                  </Table.Cell>
                )}

                {/* Permissions. A principal-bound key carries none of its own: what
                    it may do follows the bucket policies naming its holder. */}
                {showPermissions && (
                  <Table.Cell className="hidden md:table-cell">
                    {key.type === 'principal' ? (
                      <Badge
                        color="grey"
                        size="sm"
                        data-testid="permission-badge-follows-bucket-policy"
                        description="This key inherits the policy of every bucket it touches."
                      >
                        Follows bucket policy
                      </Badge>
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

                {/* Created */}
                {showCreated && (
                  <Table.Cell className="hidden text-xs text-zinc-500 lg:table-cell">
                    {formatDate(key.createdAt)}
                  </Table.Cell>
                )}

                {/* Actions */}
                {showActions && (
                  <Table.Cell className="text-right">
                    {rowHasAction(key) && <ActionMenu {...actionsFor(key)} />}
                  </Table.Cell>
                )}
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>
      {detailKey && (
        <AccessKeyPermissionsDrawer accessKey={detailKey} onClose={() => setDetailKey(null)} />
      )}
    </>
  );
}
