import { useEffect, useRef, useState } from 'react';

import {
  CopySimpleIcon,
  DotsThreeIcon,
  KeyIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react/dist/ssr';

import type { AccessKey } from '@filone/shared';

import { Button } from './Button';
import { formatDate } from '../lib/time.js';
import { useCopyToClipboard } from '../lib/use-copy-to-clipboard.js';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: AccessKey['status'] }) {
  if (status === 'active') {
    return (
      <span className="rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
        Active
      </span>
    );
  }
  return (
    <span className="rounded-full border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
      Inactive
    </span>
  );
}

function PermissionBadge({ permission }: { permission: string }) {
  return (
    <span className="rounded-full border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-[10px] font-medium uppercase text-zinc-600">
      {permission}
    </span>
  );
}

function BucketBadge({ name }: { name: string }) {
  return (
    <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-[10px] font-normal text-zinc-800">
      {name}
    </span>
  );
}

function CopyButton({ value }: { value: string }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <button
      type="button"
      onClick={() => void copy(value)}
      title={copied ? 'Copied' : 'Copy'}
      aria-label={copied ? 'Copied to clipboard' : 'Copy to clipboard'}
      className="rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
    >
      <CopySimpleIcon size={12} />
    </button>
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
        onClick={handleOpen}
        className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
        aria-label="Key actions"
      >
        <DotsThreeIcon size={16} />
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
        <KeyIcon size={48} className="mb-4 text-zinc-300" aria-hidden="true" />
        <p className="mb-1 text-sm font-medium text-zinc-900">{emptyTitle}</p>
        <p className="mb-4 text-sm text-zinc-500">{emptyDescription}</p>
        {onCreateOpen && (
          <Button variant="filled" icon={PlusIcon} onClick={onCreateOpen}>
            Create your first key
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white">
      <table className="min-w-full overflow-hidden rounded-lg">
        <thead>
          <tr>
            <th className="border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
              Name
            </th>
            {showBuckets && (
              <th className="border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                Buckets
              </th>
            )}
            {showPermissions && (
              <th className="border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                Permissions
              </th>
            )}
            <th className="border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
              Status
            </th>
            <th className="border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
              Last Used
            </th>
            {onDelete && (
              <th className="border-b border-zinc-200 bg-zinc-50 px-4 py-3" aria-label="Actions" />
            )}
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key.id} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50">
              {/* Name + Access Key ID */}
              <td className="px-4 py-3">
                <p className="text-sm font-medium text-zinc-900">{key.keyName}</p>
                <div className="flex items-center gap-1">
                  <p className="font-mono text-xs text-zinc-500">{key.accessKeyId}</p>
                  <CopyButton value={key.accessKeyId} />
                </div>
              </td>

              {/* Buckets */}
              {showBuckets && (
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {key.bucketScope === 'all' ? (
                      <BucketBadge name="All Buckets" />
                    ) : (
                      (key.buckets ?? []).map((b) => <BucketBadge key={b} name={b} />)
                    )}
                  </div>
                </td>
              )}

              {/* Permissions */}
              {showPermissions && (
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {(key.permissions ?? []).map((p) => (
                      <PermissionBadge key={p} permission={p} />
                    ))}
                  </div>
                </td>
              )}

              {/* Status */}
              <td className="px-4 py-3">
                <StatusBadge status={key.status} />
              </td>

              {/* Last Used */}
              <td className="px-4 py-3 text-sm text-zinc-600">
                {key.lastUsedAt ? formatDate(key.lastUsedAt) : 'Never'}
              </td>

              {/* Actions */}
              {onDelete && (
                <td className="px-4 py-3 text-right">
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
