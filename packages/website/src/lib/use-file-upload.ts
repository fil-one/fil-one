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
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
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
        updateEntry(e.id, { status: 'error', error: result.message });
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
        updateEntry(entry.id, { status: 'error', error: result.error });
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

  const addFiles = useCallback((incoming: FileInput[], currentPrefix: string) => {
    const entries: FileEntry[] = incoming.map((item) => {
      const file = item instanceof File ? item : item.file;
      const relativePath =
        item instanceof File
          ? (item as File & { webkitRelativePath?: string }).webkitRelativePath || undefined
          : item.relativePath;
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
  }, []);

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

    for (const e of failed) {
      updateEntry(e.id, { status: 'pending', progress: 0, error: undefined });
    }
    setUploadStep('uploading');

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
  };
}
