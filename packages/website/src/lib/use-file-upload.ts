import { useCallback, useEffect, useRef, useState } from 'react';
import type { S3Region } from '@filone/shared';
import { useToast } from '../components/Toast/index.js';
import { batchPresign } from './use-presign.js';

export type UploadStep = 'idle' | 'uploading' | 'done';

export type FileUploadStatus = 'pending' | 'uploading' | 'done' | 'error';

export type FileEntry = {
  id: string;
  file: File;
  /** Relative path for folder uploads (e.g. "photos/2024/img.jpg"). Absent for individual files. */
  relativePath?: string;
  key: string;
  status: FileUploadStatus;
  progress: number;
  error?: string;
};

/** Accepted input for addFiles: a plain File or a file with an explicit relative path (folder DnD). */
export type FileInput = File | { file: File; relativePath: string };

export type UseFileUploadOptions = {
  bucketName: string;
  region: S3Region;
  onSuccess?: () => void;
};

const PRESIGN_BATCH_SIZE = 10;

const SYSTEM_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** The path a folder upload carries, or undefined for a file the user picked one by one. */
function folderPathOf(item: FileInput): string | undefined {
  if (!(item instanceof File)) return item.relativePath;
  return (item as File & { webkitRelativePath?: string }).webkitRelativePath || undefined;
}

/**
 * Junk that comes along with a folder: OS metadata files, dot-prefixed entries and __MACOSX
 * resource forks. A file the user selected on its own is never filtered, whatever it is named.
 */
export function isSystemFileInput(item: FileInput): boolean {
  const folderPath = folderPathOf(item);
  if (!folderPath) return false;
  return folderPath
    .split('/')
    .filter(Boolean)
    .some(
      (segment) =>
        SYSTEM_FILE_NAMES.has(segment) || segment === '__MACOSX' || segment.startsWith('.'),
    );
}

function uploadedFraction(entry: FileEntry): number {
  if (entry.status === 'done') return 1;
  if (entry.status !== 'uploading') return 0;
  if (!Number.isFinite(entry.progress)) return 0;
  return Math.min(100, Math.max(0, entry.progress)) / 100;
}

export function calculateUploadProgress(entries: readonly FileEntry[]) {
  let totalBytes = 0;
  let uploadedBytes = 0;
  let totalWeight = 0;
  let uploadedWeight = 0;

  for (const entry of entries) {
    const fraction = uploadedFraction(entry);
    // An empty file weighs one byte so it cannot sit at 100% while it is still queued.
    const weight = Math.max(entry.file.size, 1);
    totalBytes += entry.file.size;
    uploadedBytes += entry.file.size * fraction;
    totalWeight += weight;
    uploadedWeight += weight * fraction;
  }

  // Floor, not round, so 100% appears only once every file is done.
  const percent = totalWeight > 0 ? Math.floor((uploadedWeight / totalWeight) * 100) : 0;
  return { totalBytes, uploadedBytes: Math.floor(uploadedBytes), percent };
}

function deriveKey(fileName: string, prefix: string): string {
  if (prefix.trim()) {
    return `${prefix.trim().replace(/\/+$/, '')}/${fileName}`;
  }
  return fileName;
}

type PresignBatchResult =
  | { type: 'job'; entry: FileEntry; url: string; method: string }
  | { type: 'error'; entries: FileEntry[]; message: string };

async function presignEntries(
  region: S3Region,
  bucketName: string,
  entries: FileEntry[],
): Promise<PresignBatchResult[]> {
  const results: PresignBatchResult[] = [];
  for (let i = 0; i < entries.length; i += PRESIGN_BATCH_SIZE) {
    const batch = entries.slice(i, i + PRESIGN_BATCH_SIZE);
    const ops = batch.map((e) => ({
      op: 'putObject' as const,
      bucket: bucketName,
      key: e.key,
      contentType: e.file.type || 'application/octet-stream',
      fileName: e.file.name,
    }));
    try {
      const { items } = await batchPresign(region, ops);
      for (let j = 0; j < batch.length; j++) {
        results.push({ type: 'job', entry: batch[j], url: items[j].url, method: items[j].method });
      }
    } catch (err) {
      results.push({
        type: 'error',
        entries: batch,
        message: err instanceof Error ? err.message : 'Presign failed',
      });
    }
  }
  return results;
}

function uploadFile(
  entry: FileEntry,
  url: string,
  method: string,
  onProgress: (progress: number) => void,
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) {
        onProgress(Math.floor((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: `HTTP ${xhr.status}` });
      }
    };
    xhr.onerror = () => resolve({ success: false, error: 'Network error' });
    xhr.open(method, url);
    xhr.setRequestHeader('Content-Type', entry.file.type || 'application/octet-stream');
    xhr.send(entry.file);
  });
}

async function uploadEntries(
  entries: FileEntry[],
  bucketName: string,
  region: S3Region,
  updateEntry: (id: string, patch: Partial<FileEntry>) => void,
): Promise<{ failedCount: number }> {
  const presignResults = await presignEntries(region, bucketName, entries);
  let failedCount = 0;
  const jobs: Array<{ entry: FileEntry; url: string; method: string }> = [];

  for (const result of presignResults) {
    if (result.type === 'error') {
      for (const e of result.entries) {
        updateEntry(e.id, { status: 'error', progress: 0, error: result.message });
        failedCount++;
      }
    } else {
      jobs.push({ entry: result.entry, url: result.url, method: result.method });
    }
  }

  await Promise.all(
    jobs.map(async ({ entry, url, method }) => {
      updateEntry(entry.id, { status: 'uploading', progress: 0 });
      const result = await uploadFile(entry, url, method, (progress) =>
        updateEntry(entry.id, { progress }),
      );
      if (result.success) {
        updateEntry(entry.id, { status: 'done', progress: 100 });
      } else {
        updateEntry(entry.id, { status: 'error', progress: 0, error: result.error });
        failedCount++;
      }
    }),
  );

  return { failedCount };
}

export function useFileUpload({ bucketName, region, onSuccess }: UseFileUploadOptions) {
  const { toast } = useToast();

  const [uploadStep, setUploadStep] = useState<UploadStep>('idle');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [prefix, setPrefix] = useState('');
  const idCounter = useRef(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setUploadStep('idle');
    setFiles([]);
    setPrefix('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (folderInputRef.current) folderInputRef.current.value = '';
  }, []);

  const addFiles = useCallback(
    (incoming: FileInput[], currentPrefix: string) => {
      const accepted = incoming.filter((item) => !isSystemFileInput(item));
      const entries: FileEntry[] = accepted.map((item) => {
        const file = item instanceof File ? item : item.file;
        const relativePath = folderPathOf(item);
        const key = relativePath ? relativePath : deriveKey(file.name, currentPrefix);
        return {
          id: `${++idCounter.current}`,
          file,
          relativePath,
          key,
          status: 'pending' as FileUploadStatus,
          progress: 0,
        };
      });

      setFiles((prev) => {
        const existingIds = new Set(prev.map((e) => e.id));
        const fresh = entries.filter((e) => !existingIds.has(e.id));
        return [...prev, ...fresh];
      });

      const skipped = incoming.length - accepted.length;
      if (skipped > 0) {
        toast.info(`Skipped ${skipped} system file${skipped > 1 ? 's' : ''}`);
      }
    },
    [toast],
  );

  const handleFilesSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(e.target.files ?? []);
      if (selected.length > 0) addFiles(selected, prefix);
      e.target.value = '';
    },
    [addFiles, prefix],
  );

  const handleFolderSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(e.target.files ?? []);
      if (selected.length > 0) addFiles(selected, '');
      e.target.value = '';
    },
    [addFiles],
  );

  // Re-derive keys for individual files (not folder uploads) when prefix changes
  useEffect(() => {
    setFiles((prev) =>
      prev.map((entry) => {
        if (entry.relativePath) return entry;
        return { ...entry, key: deriveKey(entry.file.name, prefix) };
      }),
    );
  }, [prefix]);

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const removeFolderFiles = useCallback((folderRoot: string) => {
    setFiles((prev) =>
      prev.filter((e) => !e.relativePath || e.relativePath.split('/')[0] !== folderRoot),
    );
  }, []);

  const updateEntry = useCallback((id: string, patch: Partial<FileEntry>) => {
    setFiles((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }, []);

  const handleUpload = useCallback(async () => {
    const pending = files.filter((e) => e.status === 'pending' || e.status === 'error');
    if (pending.length === 0) return;

    setUploadStep('uploading');
    const { failedCount } = await uploadEntries(pending, bucketName, region, updateEntry);

    if (failedCount === 0) {
      toast.success(
        files.length === 1
          ? `${files[0].file.name} uploaded successfully`
          : `${files.length} files uploaded successfully`,
      );
      setUploadStep('done');
      onSuccess?.();
    } else {
      toast.error(`${failedCount} file${failedCount > 1 ? 's' : ''} failed to upload`);
      setUploadStep('idle');
    }
  }, [files, bucketName, region, updateEntry, toast, onSuccess]);

  const handleRetry = useCallback(async () => {
    const failed = files.filter((e) => e.status === 'error');
    if (failed.length === 0) return;

    // Reset failed entries to pending before retrying
    for (const e of failed) {
      updateEntry(e.id, { status: 'pending', progress: 0, error: undefined });
    }
    setUploadStep('uploading');

    // Re-read from state after update — use the failed list directly
    const toRetry = failed.map((e) => ({ ...e, status: 'pending' as FileUploadStatus }));
    const { failedCount } = await uploadEntries(toRetry, bucketName, region, updateEntry);

    if (failedCount === 0) {
      toast.success('All files uploaded successfully');
      setUploadStep('done');
      onSuccess?.();
    } else {
      toast.error(`${failedCount} file${failedCount > 1 ? 's' : ''} failed to upload`);
      setUploadStep('idle');
    }
  }, [files, bucketName, region, updateEntry, toast, onSuccess]);

  const doneCount = files.filter((e) => e.status === 'done').length;
  const failedCount = files.filter((e) => e.status === 'error').length;
  const pendingCount = files.filter((e) => e.status === 'pending').length;
  const canUpload = files.some((e) => e.status === 'pending' || e.status === 'error');
  const hasIndividualFiles = files.some((e) => !e.relativePath);
  const progress = calculateUploadProgress(files);

  return {
    uploadStep,
    files,
    prefix,
    setPrefix,
    fileInputRef,
    folderInputRef,
    addFiles,
    handleFilesSelect,
    removeFolderFiles,
    handleFolderSelect,
    removeFile,
    handleUpload,
    handleRetry,
    reset,
    doneCount,
    failedCount,
    pendingCount,
    canUpload,
    hasIndividualFiles,
    totalBytes: progress.totalBytes,
    uploadedBytes: progress.uploadedBytes,
    progressPercent: progress.percent,
  };
}
