import { useEffect, useRef, useState } from 'react';

import { DotsThreeIcon, KeyIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react/dist/ssr';

import { IconBox } from './IconBox';

import type { AccessKey } from '@filone/shared';

import { Badge } from './Badge';
import { Button } from './Button';
import { CopyButton } from './CopyButton';
import { formatDate } from '../lib/time.js';

function StatusBadge({ status }: { status: AccessKey['status'] }) {
  return status === 'active' ? (
    <Badge color="green" dot size="sm" weight="medium">
      Active
    </Badge>
  ) : (
    <Badge color="grey" size="sm" weight="medium">
      Inactive
    </Badge>
  );
}

function ActionMenu({ onDelete }: { onDelete: () => void }) {
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
      <button
        ref={buttonRef}
        type="button"
        aria-label="Key actions"
        onClick={handleOpen}
        className="rounded p-1.5 text-zinc-700 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
      >
        <DotsThreeIcon weight="bold" width={18} height={18} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menuRef}
          style={{ top: pos.top, right: pos.right }}
          className="fixed z-50 w-40 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg"
        >
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
          >
            <TrashIcon size={14} />
            Delete
          </button>
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
  onDelete?: (id: string) => Promise<void>;
  onCreateOpen?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
};

const thClass =
  'border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-left text-xs font-normal text-zinc-600';
const tdClass = 'px-4 py-3';

export function AccessKeysTable({
  keys,
  showBuckets = false,
  showPermissions = false,
  onDelete,
  onCreateOpen,
  emptyTitle = 'No API keys yet',
  emptyDescription = 'Generate credentials to connect your applications via S3-compatible API',
}: AccessKeysTableProps) {
  if (keys.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-200 bg-white px-6 py-16 text-center">
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
    <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
      <table className="min-w-full">
        <thead>
          <tr>
            <th className={thClass}>Name</th>
            {showBuckets && <th className={`${thClass} hidden lg:table-cell`}>Buckets</th>}
            {showPermissions && <th className={`${thClass} hidden md:table-cell`}>Permissions</th>}
            <th className={`${thClass} hidden sm:table-cell`}>Status</th>
            <th className={`${thClass} hidden md:table-cell`}>Last Used</th>
            {onDelete && (
              <th className={thClass}>
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key.id} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50">
              {/* Name + Access Key ID */}
              <td className={tdClass}>
                <p className="text-xs font-medium text-zinc-900">{key.keyName}</p>
                <div className="flex items-center gap-1">
                  <p className="font-mono text-xs text-zinc-500">{key.accessKeyId}</p>
                  <CopyButton value={key.accessKeyId} />
                </div>
                {/* Status shown inline on small screens */}
                <div className="mt-1 sm:hidden">
                  <StatusBadge status={key.status} />
                </div>
              </td>

              {/* Buckets */}
              {showBuckets && (
                <td className={`${tdClass} hidden lg:table-cell`}>
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
                </td>
              )}

              {/* Permissions */}
              {showPermissions && (
                <td className={`${tdClass} hidden md:table-cell`}>
                  <div className="flex flex-wrap gap-1">
                    {(key.permissions ?? []).map((p) => (
                      <Badge key={p} color="blue" size="sm" className="capitalize">
                        {p}
                      </Badge>
                    ))}
                  </div>
                </td>
              )}

              {/* Status */}
              <td className={`${tdClass} hidden sm:table-cell`}>
                <StatusBadge status={key.status} />
              </td>

              {/* Last Used */}
              <td className={`${tdClass} hidden md:table-cell text-xs text-zinc-500`}>
                {key.lastUsedAt ? formatDate(key.lastUsedAt) : 'Never'}
              </td>

              {/* Actions */}
              {onDelete && (
                <td className={`${tdClass} text-right`}>
                  <ActionMenu onDelete={() => void onDelete(key.id)} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
