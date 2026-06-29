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
import { useToast } from '../components/Toast/index.js';
import { useFileUpload } from '../lib/use-file-upload.js';
import type { FileEntry, FileUploadStatus } from '../lib/use-file-upload.js';
import { resolveDropItems } from '../lib/drop-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FolderGroup = {
  type: 'folder';
  root: string;
  entries: FileEntry[];
};

type FlatFile = { type: 'file'; entry: FileEntry };

type ListItem = FolderGroup | FlatFile;

function groupEntries(files: FileEntry[]): ListItem[] {
  const folders = new Map<string, FileEntry[]>();
  const flat: FileEntry[] = [];

  for (const entry of files) {
    if (entry.relativePath) {
      const root = entry.relativePath.split('/')[0];
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
      <div
        data-testid="upload-item"
        data-object-key={entry.key}
        data-upload-status={entry.status}
        className="group flex items-center gap-3 px-3 py-2 hover:bg-zinc-50"
      >
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
            onClick={(e) => {
              e.stopPropagation();
              onRemove(group.root);
            }}
          />
        )}
      </div>
      {expanded &&
        group.entries.map((entry) => {
          const name = entry.relativePath
            ? entry.relativePath.split('/').slice(1).join('/')
            : entry.file.name;
          return <FileRow key={entry.id} entry={entry} nameOverride={name} />;
        })}
    </>
  );
}

type DropzoneAreaProps = {
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  folderInputRef: React.RefObject<HTMLInputElement | null>;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
};

function DropzoneArea({ fileInputRef, folderInputRef, onDrop }: DropzoneAreaProps) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-(--state-card-border-color) px-6 py-10 text-center"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <div className="flex flex-col items-center gap-3">
        <IconBox icon={CloudArrowUpIcon} color="blue" size="md" rounded="full" />
        <div className="flex flex-col items-center gap-0.5">
          <p className="text-sm font-medium text-zinc-700">Drag and drop files or folders here</p>
          <p className="text-xs text-zinc-500">Any file type up to 5 GB</p>
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          icon={FileIcon}
          onClick={() => fileInputRef.current?.click()}
        >
          Select files
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={FolderIcon}
          onClick={() => folderInputRef.current?.click()}
        >
          Select folder
        </Button>
      </div>
    </div>
  );
}

type FileListSectionProps = {
  listItems: ListItem[];
  expandedFolders: Set<string>;
  onToggleFolder: (root: string) => void;
  onRemoveFile?: (id: string) => void;
  onRemoveFolder?: (root: string) => void;
  fileCount: number;
  uploading: boolean;
  onClear: () => void;
};

function FileListSection({
  listItems,
  expandedFolders,
  onToggleFolder,
  onRemoveFile,
  onRemoveFolder,
  fileCount,
  uploading,
  onClear,
}: FileListSectionProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>
          {fileCount} file{fileCount > 1 ? 's' : ''} selected
        </Label>
        {!uploading && (
          <Button variant="tertiary" size="sm" onClick={onClear}>
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
              onToggle={() => onToggleFolder(item.root)}
              onRemove={onRemoveFolder}
            />
          ) : (
            <FileRow key={item.entry.id} entry={item.entry} onRemove={onRemoveFile} />
          ),
        )}
      </div>
    </div>
  );
}

type UploadActionsProps = {
  failedCount: number;
  pendingCount: number;
  canUpload: boolean;
  onRetry: () => void;
  onUpload: () => void;
};

function UploadActions({
  failedCount,
  pendingCount,
  canUpload,
  onRetry,
  onUpload,
}: UploadActionsProps) {
  const uploadLabel =
    pendingCount > 0 ? `Upload ${pendingCount} file${pendingCount > 1 ? 's' : ''}` : 'Upload';
  return (
    <div className="flex gap-2">
      {failedCount > 0 && (
        <Button
          id="upload-retry-button"
          variant="tertiary"
          icon={ArrowCounterClockwiseIcon}
          onClick={onRetry}
        >
          Retry {failedCount} failed
        </Button>
      )}
      <Button
        id="upload-submit-button"
        variant="primary"
        className="flex-1"
        disabled={!canUpload}
        onClick={onUpload}
      >
        {uploadLabel}
      </Button>
    </div>
  );
}

type UploadDoneCardProps = {
  bucketName: string;
  doneCount: number;
  onBack: () => void;
};

function UploadDoneCard({ bucketName, doneCount, onBack }: UploadDoneCardProps) {
  return (
    <Card>
      <div className="flex flex-col items-center gap-3 py-6">
        <Icon component={CheckCircleIcon} size={40} color="success" />
        <p className="text-sm font-medium text-zinc-900">Upload complete.</p>
        <p className="text-xs text-zinc-500">
          {doneCount} file{doneCount > 1 ? 's' : ''} uploaded to{' '}
          <span className="font-medium text-zinc-700">{bucketName}</span>.
        </p>
        <Button variant="primary" onClick={onBack}>
          Back to bucket
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export type UploadObjectPageProps = {
  bucketName: string;
  region: S3Region;
};

export function UploadObjectPage({ bucketName, region }: UploadObjectPageProps) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  const upload = useFileUpload({
    bucketName,
    region,
    onSuccess: () => {
      void navigate({ to: '/buckets/$bucketName', params: { bucketName }, search: { region } });
    },
  });

  const goToBucket = () =>
    void navigate({ to: '/buckets/$bucketName', params: { bucketName }, search: { region } });

  const toggleFolder = (root: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  };

  const handleClearAll = () => {
    upload.reset();
    setExpandedFolders(new Set());
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    resolveDropItems(e.dataTransfer).then(
      (items) => {
        if (items.length > 0) upload.addFiles(items, upload.prefix);
      },
      () => {
        toast.error('Failed to read dropped items');
      },
    );
  };

  const listItems = groupEntries(upload.files);
  const isUploading = upload.uploadStep === 'uploading';
  const removeFile = isUploading ? undefined : upload.removeFile;
  const removeFolderFiles = isUploading ? undefined : upload.removeFolderFiles;

  const breadcrumb = [
    { label: 'Buckets', href: '/buckets' },
    { label: bucketName, href: `/buckets/${bucketName}?region=${region}` },
    { label: 'Upload' },
  ];

  if (upload.uploadStep === 'done') {
    return (
      <div className="mx-auto max-w-2xl px-5 pt-6 sm:px-8 lg:px-10 lg:pt-10">
        <Breadcrumb items={breadcrumb} />
        <UploadDoneCard bucketName={bucketName} doneCount={upload.doneCount} onBack={goToBucket} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-5 pt-6 sm:px-8 lg:px-10 lg:pt-10">
      <Breadcrumb items={breadcrumb} />

      <div className="mt-6 mb-6 flex items-center gap-4">
        <IconButton icon={ArrowLeftIcon} aria-label="Back to bucket" onClick={goToBucket} />
        <div>
          <Heading tag="h1">Upload</Heading>
          <p className="text-[13px] text-zinc-500">
            Upload files to <span className="font-medium text-zinc-700">{bucketName}</span>
          </p>
        </div>
      </div>

      <Card>
        <div className="flex flex-col gap-5">
          {isUploading && (
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

          {!isUploading && (
            <DropzoneArea
              fileInputRef={upload.fileInputRef}
              folderInputRef={upload.folderInputRef}
              onDrop={handleDrop}
            />
          )}

          <input
            ref={upload.fileInputRef}
            id="upload-file-input"
            type="file"
            multiple
            className="hidden"
            onChange={upload.handleFilesSelect}
          />
          <input
            ref={upload.folderInputRef}
            id="upload-folder-input"
            type="file"
            // @ts-expect-error — webkitdirectory is not in React's types
            webkitdirectory=""
            className="hidden"
            onChange={upload.handleFolderSelect}
          />

          {upload.files.length > 0 && upload.hasIndividualFiles && (
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
                disabled={isUploading}
              />
            </FormField>
          )}

          {upload.files.length > 0 && (
            <FileListSection
              listItems={listItems}
              expandedFolders={expandedFolders}
              onToggleFolder={toggleFolder}
              onRemoveFile={removeFile}
              onRemoveFolder={removeFolderFiles}
              fileCount={upload.files.length}
              uploading={isUploading}
              onClear={handleClearAll}
            />
          )}

          {!isUploading && (
            <UploadActions
              failedCount={upload.failedCount}
              pendingCount={upload.pendingCount}
              canUpload={upload.canUpload}
              onRetry={() => void upload.handleRetry()}
              onUpload={() => void upload.handleUpload()}
            />
          )}
        </div>
      </Card>
    </div>
  );
}
