import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowLeftIcon,
  CloudArrowUpIcon,
  FileIcon,
  FolderIcon,
  CheckCircleIcon,
  WarningCircleIcon,
  ArrowCounterClockwiseIcon,
  XIcon,
} from '@phosphor-icons/react/dist/ssr';

import { formatBytes, S3Region } from '@filone/shared';

import { Heading } from '../components/Heading/Heading';
import { Breadcrumb } from '../components/Breadcrumb';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { Input } from '../components/Input';
import { FormField } from '../components/FormField';
import { IconBox } from '../components/IconBox';
import { Label } from '../components/Label';
import { ProgressBar } from '../components/ProgressBar';
import { Spinner } from '../components/Spinner';
import { useFileUpload } from '../lib/use-file-upload.js';
import type { FileEntry, FileUploadStatus } from '../lib/use-file-upload.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FolderGroup = {
  type: 'folder';
  root: string;
  entries: FileEntry[];
};

type FlatFile = {
  type: 'file';
  entry: FileEntry;
};

type ListItem = FolderGroup | FlatFile;

function groupEntries(files: FileEntry[]): ListItem[] {
  const folders = new Map<string, FileEntry[]>();
  const flat: FileEntry[] = [];

  for (const entry of files) {
    const rel = (entry.file as File & { webkitRelativePath?: string }).webkitRelativePath;
    if (rel) {
      const root = rel.split('/')[0];
      const group = folders.get(root) ?? [];
      group.push(entry);
      folders.set(root, group);
    } else {
      flat.push(entry);
    }
  }

  const items: ListItem[] = [];
  for (const [root, entries] of folders) {
    items.push({ type: 'folder', root, entries });
  }
  for (const entry of flat) {
    items.push({ type: 'file', entry });
  }
  return items;
}

function folderStatus(entries: FileEntry[]): FileUploadStatus {
  if (entries.some((e) => e.status === 'uploading')) return 'uploading';
  if (entries.some((e) => e.status === 'error')) return 'error';
  if (entries.every((e) => e.status === 'done')) return 'done';
  return 'pending';
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FileRow({
  entry,
  nameOverride,
  onRemove,
}: {
  entry: FileEntry;
  nameOverride?: string;
  onRemove?: (id: string) => void;
}) {
  return (
    <>
      <div className="group flex items-center gap-3 px-3 py-2 hover:bg-zinc-50">
        <span className="text-zinc-400">
          <FileIcon size={13} aria-hidden="true" />
        </span>
        <span className="flex-1 truncate text-sm text-zinc-700">{nameOverride ?? entry.key}</span>
        <span className="shrink-0 text-xs tabular-nums text-zinc-600">
          {formatBytes(entry.file.size)}
        </span>
        {entry.status === 'done' && <Icon component={CheckCircleIcon} size={13} color="success" />}
        {entry.status === 'error' && <Icon component={WarningCircleIcon} size={13} color="error" />}
        {entry.status === 'uploading' && <Spinner size={12} ariaLabel="Uploading" />}
        {onRemove && entry.status === 'pending' && (
          <IconButton
            icon={XIcon}
            size="sm"
            aria-label={`Remove ${entry.file.name}`}
            onClick={() => onRemove(entry.id)}
          />
        )}
      </div>
      {entry.status === 'error' && entry.error && (
        <p className="px-3 pb-1.5 text-xs text-(--color-brand-error)">{entry.error}</p>
      )}
    </>
  );
}

function FolderRow({
  group,
  expanded,
  onToggle,
  onRemove,
}: {
  group: FolderGroup;
  expanded: boolean;
  onToggle: () => void;
  onRemove?: (root: string) => void;
}) {
  const totalSize = group.entries.reduce((sum, e) => sum + e.file.size, 0);
  const status = folderStatus(group.entries);
  const canRemove = onRemove && group.entries.every((e) => e.status === 'pending');

  return (
    <>
      <div
        className="group flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-zinc-50"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span className="text-zinc-400">
          <FolderIcon size={13} aria-hidden="true" />
        </span>
        <span className="flex-1 truncate text-sm font-medium text-zinc-700">{group.root}</span>
        <span className="shrink-0 text-xs tabular-nums text-zinc-600">
          {group.entries.length} files · {formatBytes(totalSize)}
        </span>
        {status === 'done' && <Icon component={CheckCircleIcon} size={13} color="success" />}
        {status === 'error' && <Icon component={WarningCircleIcon} size={13} color="error" />}
        {status === 'uploading' && <Spinner size={12} ariaLabel="Uploading folder" />}
        {canRemove && (
          <IconButton
            icon={XIcon}
            size="sm"
            aria-label={`Remove folder ${group.root}`}
            onClick={() => onRemove(group.root)}
          />
        )}
      </div>
      {expanded &&
        group.entries.map((entry) => {
          const rel = (entry.file as File & { webkitRelativePath?: string }).webkitRelativePath;
          const name = rel ? rel.split('/').slice(1).join('/') : entry.file.name;
          return <FileRow key={entry.id} entry={entry} nameOverride={name} />;
        })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export type UploadObjectPageProps = {
  bucketName: string;
  region: S3Region;
};

// eslint-disable-next-line max-lines-per-function, complexity/complexity
export function UploadObjectPage({ bucketName, region }: UploadObjectPageProps) {
  const navigate = useNavigate();
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  const upload = useFileUpload({
    bucketName,
    region,
    onSuccess: () => {
      void navigate({ to: '/buckets/$bucketName', params: { bucketName }, search: { region } });
    },
  });

  const toggleFolder = (root: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(root)) {
        next.delete(root);
      } else {
        next.add(root);
      }
      return next;
    });
  };

  const listItems = groupEntries(upload.files);
  const failedFiles = upload.files.filter((e) => e.status === 'error');
  const pendingFiles = upload.files.filter((e) => e.status === 'pending');
  const hasIndividualFiles = upload.files.some(
    (e) => !(e.file as File & { webkitRelativePath?: string }).webkitRelativePath,
  );

  return (
    <div className="mx-auto max-w-2xl px-10 pt-10">
      <Breadcrumb
        items={[
          { label: 'Buckets', href: '/buckets' },
          { label: bucketName, href: `/buckets/${bucketName}?region=${region}` },
          { label: 'Upload' },
        ]}
      />

      <div className="mt-6 mb-6 flex items-center gap-4">
        <IconButton
          icon={ArrowLeftIcon}
          aria-label="Back to bucket"
          onClick={() =>
            navigate({ to: '/buckets/$bucketName', params: { bucketName }, search: { region } })
          }
        />
        <div>
          <Heading tag="h1">Upload</Heading>
          <p className="text-[13px] text-zinc-500">
            Upload files to <span className="font-medium text-zinc-700">{bucketName}</span>
          </p>
        </div>
      </div>

      {upload.uploadStep !== 'done' && (
        <Card>
          <div className="flex flex-col gap-5">
            {/* Aggregate progress — shown during upload */}
            {upload.uploadStep === 'uploading' && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-zinc-700">Uploading files…</span>
                  <span className="text-sm tabular-nums text-zinc-500">
                    {upload.doneCount} / {upload.files.length}
                  </span>
                </div>
                <ProgressBar
                  value={
                    upload.files.length > 0
                      ? Math.round((upload.doneCount / upload.files.length) * 100)
                      : 0
                  }
                  label="Overall upload progress"
                />
              </div>
            )}

            {/* Dropzone — hidden during upload */}
            <div
              className={`flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-(--state-card-border-color) px-6 py-10 text-center${upload.uploadStep === 'uploading' ? ' hidden' : ''}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const dropped = Array.from(e.dataTransfer.files);
                if (dropped.length > 0) upload.addFiles(dropped, upload.prefix);
              }}
            >
              <div className="flex flex-col items-center gap-3">
                <IconBox icon={CloudArrowUpIcon} color="blue" size="md" rounded="full" />
                <div className="flex flex-col items-center gap-0.5">
                  <p className="text-sm font-medium text-zinc-700">
                    Drag and drop files or folders here
                  </p>
                  <p className="text-xs text-zinc-500">Any file type up to 5 GB</p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={FileIcon}
                  onClick={() => upload.fileInputRef.current?.click()}
                >
                  Select files
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={FolderIcon}
                  onClick={() => upload.folderInputRef.current?.click()}
                >
                  Select folder
                </Button>
              </div>
            </div>

            {/* Hidden inputs */}
            <input
              ref={upload.fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={upload.handleFilesSelect}
            />
            <input
              ref={upload.folderInputRef}
              type="file"
              // @ts-expect-error — webkitdirectory is not in React's types
              webkitdirectory=""
              className="hidden"
              onChange={upload.handleFolderSelect}
            />

            {/* Optional prefix for individual file uploads */}
            {upload.files.length > 0 && hasIndividualFiles && (
              <FormField
                label="Prefix"
                optional
                htmlFor="object-prefix"
                description="Optional folder path prepended to all file names, e.g. images/"
              >
                <Input
                  id="object-prefix"
                  value={upload.prefix}
                  onChange={upload.setPrefix}
                  placeholder="images/"
                  autoComplete="off"
                  disabled={upload.uploadStep === 'uploading'}
                />
              </FormField>
            )}

            {/* File / folder list */}
            {upload.files.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <Label>
                    {upload.files.length} file{upload.files.length > 1 ? 's' : ''} selected
                  </Label>
                  {upload.uploadStep === 'idle' && (
                    <Button variant="tertiary" size="sm" onClick={upload.reset}>
                      Clear all
                    </Button>
                  )}
                </div>
                <div className="overflow-hidden rounded-lg border border-zinc-200 divide-y divide-zinc-100">
                  {listItems.map((item) =>
                    item.type === 'folder' ? (
                      <FolderRow
                        key={item.root}
                        group={item}
                        expanded={expandedFolders.has(item.root)}
                        onToggle={() => toggleFolder(item.root)}
                        onRemove={
                          upload.uploadStep === 'idle' ? upload.removeFolderFiles : undefined
                        }
                      />
                    ) : (
                      <FileRow
                        key={item.entry.id}
                        entry={item.entry}
                        onRemove={upload.uploadStep === 'idle' ? upload.removeFile : undefined}
                      />
                    ),
                  )}
                </div>
              </div>
            )}

            {/* Actions — hidden during upload */}
            {upload.uploadStep !== 'uploading' && (
              <div className="flex gap-2">
                {failedFiles.length > 0 && upload.uploadStep === 'idle' && (
                  <Button
                    variant="tertiary"
                    icon={ArrowCounterClockwiseIcon}
                    onClick={() => void upload.handleRetry()}
                  >
                    Retry {failedFiles.length} failed
                  </Button>
                )}
                <Button
                  variant="primary"
                  className="flex-1"
                  disabled={!upload.canUpload}
                  onClick={() => void upload.handleUpload()}
                >
                  {pendingFiles.length > 0
                    ? `Upload ${pendingFiles.length} file${pendingFiles.length > 1 ? 's' : ''}`
                    : 'Upload'}
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Done state */}
      {upload.uploadStep === 'done' && (
        <Card>
          <div className="flex flex-col items-center gap-3 py-6">
            <Icon component={CheckCircleIcon} size={40} color="success" />
            <p className="text-sm font-medium text-zinc-900">Upload complete.</p>
            <p className="text-xs text-zinc-500">
              {upload.doneCount} file{upload.doneCount > 1 ? 's' : ''} uploaded to{' '}
              <span className="font-medium text-zinc-700">{bucketName}</span>.
            </p>
            <Button
              variant="primary"
              onClick={() =>
                void navigate({
                  to: '/buckets/$bucketName',
                  params: { bucketName },
                  search: { region },
                })
              }
            >
              Back to bucket
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
