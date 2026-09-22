import { useEffect, useRef, useState } from 'react';

import {
  ArrowsClockwiseIcon,
  DotsThreeIcon,
  KeyIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react/dist/ssr';

import { IconBox } from './IconBox';

import type { AccessKey, GranularPermission } from '@filone/shared';
import {
  BUCKET_INFO_PERMISSION_LABELS,
  BUCKET_PERMISSION_LABELS,
  GRANULAR_PERMISSION_LABELS,
  getRegionLabel,
  isBucketInfoPermission,
  isBucketPermission,
  isObjectPermission,
} from '@filone/shared';

import { Badge } from './Badge';
import { Button } from './Button';
import { CopyButton } from './CopyButton';
import { IconButton } from './IconButton';
import { Table } from './Table/Table';
import { formatDate } from '../lib/time.js';

function StatusBadge({ status }: { status: AccessKey['status'] }) {
  return status === 'active' ? (
    <Badge color="green" dot size="sm" weight="medium">
      Active
    </Badge>
  ) : (
    <Badge color="grey" dot size="sm" weight="medium">
      Inactive
    </Badge>
  );
}

function PermissionBadges({
  permissions,
  granularPermissions,
}: {
  permissions: AccessKey['permissions'];
  granularPermissions: GranularPermission[];
}) {
  const objectPermissions = permissions.filter(isObjectPermission);
  const bucketManagement = permissions.filter(isBucketPermission);
  const bucketInfo = permissions.filter(isBucketInfoPermission);

  return (
    <div className="flex flex-wrap gap-1">
      {objectPermissions.map((p) => (
        <Badge key={p} color="blue" size="sm" className="capitalize">
          {p}
        </Badge>
      ))}
      {granularPermissions.length > 0 && (
        <GroupBadge
          title="Data protection"
          testId="permission-badge-data-protection"
          items={granularPermissions.map((g) => ({
            key: g,
            label: GRANULAR_PERMISSION_LABELS[g].label,
          }))}
        />
      )}
      {bucketManagement.length > 0 && (
        <GroupBadge
          title="Bucket management"
          testId="permission-badge-bucket-management"
          items={bucketManagement.map((p) => ({
            key: p,
            label: BUCKET_PERMISSION_LABELS[p].label,
          }))}
        />
      )}
      {bucketInfo.length > 0 && (
        <GroupBadge
          title="Bucket info"
          testId="permission-badge-bucket-info"
          items={bucketInfo.map((p) => ({
            key: p,
            label: BUCKET_INFO_PERMISSION_LABELS[p].label,
          }))}
        />
      )}
    </div>
  );
}

function GroupBadge({
  title,
  testId,
  items,
}: {
  title: string;
  testId: string;
  items: { key: string; label: string }[];
}) {
  return (
    <Badge
      color="blue"
      size="sm"
      data-testid={testId}
      description={
        <>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
            {title}
          </p>
          <ul className="flex flex-col gap-0.5">
            {items.map((item) => (
              <li key={item.key} className="text-xs text-zinc-700">
                {item.label}
              </li>
            ))}
          </ul>
        </>
      }
    >
      {title}
    </Badge>
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
          className="fixed z-50 w-40 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg"
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
  showBuckets?: boolean;
  showPermissions?: boolean;
  showRegion?: boolean;
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

export function AccessKeysTable({
  keys,
  showBuckets = false,
  showPermissions = false,
  showRegion = false,
  creatorFor,
  onDelete,
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
    <Table>
      <Table.Header>
        <Table.Row>
          <Table.Head>Name</Table.Head>
          {showRegion && <Table.Head className="hidden md:table-cell">Region</Table.Head>}
          {showBuckets && <Table.Head className="hidden lg:table-cell">Buckets</Table.Head>}
          {showPermissions && <Table.Head className="hidden md:table-cell">Permissions</Table.Head>}
          {showCreatedBy && <Table.Head className="hidden lg:table-cell">Created by</Table.Head>}
          <Table.Head className="hidden sm:table-cell">Status</Table.Head>
          <Table.Head className="hidden md:table-cell">Last Used</Table.Head>
          {showActions && (
            <Table.Head>
              <span className="sr-only">Actions</span>
            </Table.Head>
          )}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {keys.map((key) => (
          <Table.Row key={key.id} data-testid="access-key-row" data-access-key-id={key.accessKeyId}>
            {/* Name + Access Key ID */}
            <Table.Cell>
              <p className="text-xs font-medium text-zinc-900">{key.keyName}</p>
              <div className="flex items-center gap-1">
                <p className="font-mono text-xs text-zinc-500">{key.accessKeyId}</p>
                <CopyButton value={key.accessKeyId} />
              </div>
              {/* Status shown inline on small screens */}
              <div className="mt-1 sm:hidden">
                <StatusBadge status={key.status} />
              </div>
            </Table.Cell>

            {/* Regions — a key works at every region of the storage network that holds it */}
            {showRegion && (
              <Table.Cell className="hidden md:table-cell">
                {key.regions.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {key.regions.map((region) => (
                      <Badge
                        key={region}
                        color="grey"
                        size="sm"
                        description={getRegionLabel(region)}
                      >
                        {region}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <span className="text-xs text-zinc-400">—</span>
                )}
              </Table.Cell>
            )}

            {/* Buckets */}
            {showBuckets && (
              <Table.Cell className="hidden lg:table-cell">
                <div className="flex flex-wrap gap-1">
                  {key.bucketScope === 'all' ? (
                    <Badge color="grey" size="sm">
                      All Buckets
                    </Badge>
                  ) : (
                    (key.buckets ?? []).map((b) => (
                      <Badge key={b} color="grey" size="sm">
                        {b}
                      </Badge>
                    ))
                  )}
                </div>
              </Table.Cell>
            )}

            {/* Permissions */}
            {showPermissions && (
              <Table.Cell className="hidden md:table-cell">
                <PermissionBadges
                  permissions={key.permissions ?? []}
                  granularPermissions={key.granularPermissions ?? []}
                />
              </Table.Cell>
            )}

            {showCreatedBy && (
              <Table.Cell className="hidden lg:table-cell">
                <Attribution accessKey={key} creatorFor={creatorFor} />
              </Table.Cell>
            )}

            {/* Status */}
            <Table.Cell className="hidden sm:table-cell">
              <StatusBadge status={key.status} />
            </Table.Cell>

            {/* Last Used */}
            <Table.Cell className="hidden md:table-cell text-xs text-zinc-500">
              {key.lastUsedAt ? formatDate(key.lastUsedAt) : 'Never'}
            </Table.Cell>

            {/* Actions */}
            {showActions && (
              <Table.Cell className="text-right">
                {rowHasAction(key) && <ActionMenu {...actionsFor(key)} />}
              </Table.Cell>
            )}
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
}
