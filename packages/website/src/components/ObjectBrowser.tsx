import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowUpIcon,
  CloudArrowUpIcon,
  DownloadSimpleIcon,
  FileIcon,
  FolderIcon,
  TrashIcon,
} from '@phosphor-icons/react/dist/ssr';

import { formatBytes } from '@filone/shared';
import type { S3Object } from '@filone/shared';

import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';
import { Spinner } from './Spinner';
import { formatDate } from '../lib/time.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type BrowseEntry =
  | { kind: 'folder'; name: string; prefix: string }
  | { kind: 'object'; name: string; object: S3Object };

function getEntriesAtPrefix(objects: S3Object[], prefix: string): BrowseEntry[] {
  const folders = new Set<string>();
  const files: BrowseEntry[] = [];

  for (const obj of objects) {
    if (!obj.key.startsWith(prefix)) continue;
    const remainder = obj.key.slice(prefix.length);
    const slashIdx = remainder.indexOf('/');
    if (slashIdx === -1) {
      files.push({ kind: 'object', name: remainder, object: obj });
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
// Component
// ---------------------------------------------------------------------------

export type ObjectBrowserProps = {
  bucketName: string;
  objects: S3Object[];
  currentPrefix: string;
  onPrefixChange: (prefix: string) => void;
  onDownload: (key: string) => void;
  downloading: string | null;
  onDelete: (key: string) => Promise<void>;
};

export function ObjectBrowser({
  bucketName,
  objects,
  currentPrefix,
  onPrefixChange,
  onDownload,
  downloading,
  onDelete,
}: ObjectBrowserProps) {
  const navigate = useNavigate();
  const [confirmDeleteObject, setConfirmDeleteObject] = useState<string | null>(null);

  if (objects.length === 0) {
    return (
      <div className="mt-4 flex flex-col items-center justify-center rounded-lg border border-zinc-200 bg-white px-6 py-16 text-center">
        <CloudArrowUpIcon size={48} className="mb-4 text-zinc-300" aria-hidden="true" />
        <p className="mb-1 text-base font-medium text-zinc-700">No objects yet</p>
        <p className="mb-6 text-sm text-zinc-500">Upload your first object to this bucket</p>
        <Button
          variant="primary"
          icon={ArrowUpIcon}
          onClick={() =>
            void navigate({
              to: '/buckets/$bucketName/upload',
              params: { bucketName },
            })
          }
        >
          Upload object
        </Button>
      </div>
    );
  }

  const entries = getEntriesAtPrefix(objects, currentPrefix);

  return (
    <div className="mt-4">
      {/* Prefix breadcrumb */}
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

      {entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-200 bg-white px-6 py-16 text-center">
          <p className="text-sm text-zinc-500">No objects at this path</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Name
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Size
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Last Modified
                </th>
                <th className="px-4 py-3" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) =>
                entry.kind === 'folder' ? (
                  <tr
                    key={`folder:${entry.prefix}`}
                    className="cursor-pointer border-b border-zinc-100 last:border-0 hover:bg-zinc-50"
                    onClick={() => onPrefixChange(entry.prefix)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 font-medium text-zinc-900">
                        <FolderIcon
                          size={16}
                          className="shrink-0 text-zinc-400"
                          aria-hidden="true"
                        />
                        {entry.name}/
                      </div>
                    </td>
                    <td className="px-4 py-3 text-zinc-400">&mdash;</td>
                    <td className="px-4 py-3 text-zinc-400">&mdash;</td>
                    <td className="px-4 py-3" />
                  </tr>
                ) : (
                  <tr
                    key={`object:${entry.object.key}`}
                    className="cursor-pointer border-b border-zinc-100 last:border-0 hover:bg-zinc-50"
                    role="button"
                    tabIndex={0}
                    onClick={() =>
                      void navigate({
                        to: '/buckets/$bucketName/objects',
                        params: { bucketName },
                        search: { key: entry.object.key },
                      })
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        void navigate({
                          to: '/buckets/$bucketName/objects',
                          params: { bucketName },
                          search: { key: entry.object.key },
                        });
                      }
                    }}
                  >
                    <td className="px-4 py-3">
                      <div
                        className="flex items-center gap-2 font-medium text-zinc-900"
                        title={entry.object.key}
                      >
                        <FileIcon size={16} className="shrink-0 text-zinc-400" aria-hidden="true" />
                        {entry.name}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-zinc-600">
                      {formatBytes(entry.object.sizeBytes)}
                    </td>
                    <td className="px-4 py-3 text-zinc-600">
                      {formatDate(entry.object.lastModified)}
                    </td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          aria-label={`Download ${entry.name}`}
                          onClick={() => onDownload(entry.object.key)}
                          disabled={downloading === entry.object.key}
                          className="text-zinc-400 hover:text-brand-600 disabled:opacity-50"
                        >
                          {downloading === entry.object.key ? (
                            <Spinner ariaLabel="Downloading" size={16} />
                          ) : (
                            <DownloadSimpleIcon size={16} aria-hidden="true" />
                          )}
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${entry.name}`}
                          onClick={() => setConfirmDeleteObject(entry.object.key)}
                          className="text-zinc-400 hover:text-red-500"
                        >
                          <TrashIcon size={16} aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={confirmDeleteObject !== null}
        onClose={() => setConfirmDeleteObject(null)}
        onConfirm={() => {
          if (!confirmDeleteObject) return Promise.resolve();
          return onDelete(confirmDeleteObject);
        }}
        title="Delete object"
        description="This object will be permanently deleted. This action cannot be undone."
        confirmLabel="Delete object"
      />
    </div>
  );
}
