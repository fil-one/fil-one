import { useCallback, useEffect, useRef, useState } from 'react';
import type { S3Region } from '@filone/shared';
import { useToast } from '../components/Toast/index.js';
import { batchPresign } from './use-presign.js';

export type UploadStep = 'idle' | 'uploading' | 'done';

export type FileUploadStatus = 'pending' | 'uploading' | 'done' | 'error';

export type FileEntry = {
  id: string;
  file: File;
  key: string;
  status: FileUploadStatus;
  progress: number;
  error?: string;
};

export type UseFileUploadOptions = {
  bucketName: string;
  region: S3Region;
  onSuccess?: () => void;
};

const PRESIGN_BATCH_SIZE = 10;

function deriveKey(file: File, prefix: string): string {
  const base = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  if (prefix.trim()) {
    return `${prefix.trim().replace(/\/+$/, '')}/${base}`;
  }
  return base;
}

// eslint-disable-next-line max-lines-per-function
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

  const addFiles = useCallback((incoming: File[], currentPrefix: string) => {
    const entries: FileEntry[] = incoming.map((file) => ({
      id: `${++idCounter.current}`,
      file,
      key: deriveKey(file, currentPrefix),
      status: 'pending' as FileUploadStatus,
      progress: 0,
    }));

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

  // Re-derive keys for individual files (not folder uploads) when prefix changes
  useEffect(() => {
    setFiles((prev) =>
      prev.map((entry) => {
        const rel = (entry.file as File & { webkitRelativePath?: string }).webkitRelativePath;
        if (rel) return entry;
        return { ...entry, key: deriveKey(entry.file, prefix) };
      }),
    );
  }, [prefix]);

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const removeFolderFiles = useCallback((folderRoot: string) => {
    setFiles((prev) =>
      prev.filter((e) => {
        const rel = (e.file as File & { webkitRelativePath?: string }).webkitRelativePath;
        return !rel || rel.split('/')[0] !== folderRoot;
      }),
    );
  }, []);

  const updateEntry = useCallback((id: string, patch: Partial<FileEntry>) => {
    setFiles((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }, []);

  const uploadEntries = useCallback(
    async (entries: FileEntry[]) => {
      // Chunk into batches of PRESIGN_BATCH_SIZE for presign API
      const batches: FileEntry[][] = [];
      for (let i = 0; i < entries.length; i += PRESIGN_BATCH_SIZE) {
        batches.push(entries.slice(i, i + PRESIGN_BATCH_SIZE));
      }

      // Presign all batches, collect (entry, presignedUrl, method) tuples
      type UploadJob = { entry: FileEntry; url: string; method: string };
      const jobs: UploadJob[] = [];

      for (const batch of batches) {
        const ops = batch.map((e) => ({
          op: 'putObject' as const,
          bucket: bucketName,
          key: e.key,
          contentType: e.file.type || 'application/octet-stream',
          fileName: e.file.name,
        }));

        let items;
        try {
          ({ items } = await batchPresign(region, ops));
        } catch (err) {
          // Mark whole batch as failed
          for (const e of batch) {
            updateEntry(e.id, {
              status: 'error',
              error: err instanceof Error ? err.message : 'Presign failed',
            });
          }
          continue;
        }

        for (let i = 0; i < batch.length; i++) {
          jobs.push({ entry: batch[i], url: items[i].url, method: items[i].method });
        }
      }

      // Upload all jobs in parallel
      await Promise.all(
        jobs.map(({ entry, url, method }) => {
          updateEntry(entry.id, { status: 'uploading', progress: 0 });
          return new Promise<void>((resolve) => {
            const xhr = new XMLHttpRequest();
            xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) {
                updateEntry(entry.id, { progress: Math.round((e.loaded / e.total) * 100) });
              }
            };
            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                updateEntry(entry.id, { status: 'done', progress: 100 });
              } else {
                updateEntry(entry.id, {
                  status: 'error',
                  error: `HTTP ${xhr.status}`,
                });
              }
              resolve();
            };
            xhr.onerror = () => {
              updateEntry(entry.id, { status: 'error', error: 'Network error' });
              resolve();
            };
            xhr.open(method, url);
            xhr.setRequestHeader('Content-Type', entry.file.type || 'application/octet-stream');
            xhr.send(entry.file);
          });
        }),
      );
    },
    [bucketName, region, updateEntry],
  );

  const handleUpload = useCallback(async () => {
    const pending = files.filter((e) => e.status === 'pending' || e.status === 'error');
    if (pending.length === 0) return;

    setUploadStep('uploading');
    await uploadEntries(pending);

    setFiles((current) => {
      const failed = current.filter((e) => e.status === 'error');
      if (failed.length === 0) {
        toast.success(
          current.length === 1
            ? `${current[0].file.name} uploaded successfully`
            : `${current.length} files uploaded successfully`,
        );
        setUploadStep('done');
        onSuccess?.();
      } else {
        toast.error(`${failed.length} file${failed.length > 1 ? 's' : ''} failed to upload`);
        setUploadStep('idle');
      }
      return current;
    });
  }, [files, uploadEntries, toast, onSuccess]);

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
    await uploadEntries(toRetry);

    setFiles((current) => {
      const stillFailed = current.filter((e) => e.status === 'error');
      if (stillFailed.length === 0) {
        toast.success('All files uploaded successfully');
        setUploadStep('done');
        onSuccess?.();
      } else {
        toast.error(
          `${stillFailed.length} file${stillFailed.length > 1 ? 's' : ''} failed to upload`,
        );
        setUploadStep('idle');
      }
      return current;
    });
  }, [files, uploadEntries, updateEntry, toast, onSuccess]);

  const doneCount = files.filter((e) => e.status === 'done').length;
  const failedCount = files.filter((e) => e.status === 'error').length;
  const canUpload = files.some((e) => e.status === 'pending' || e.status === 'error');

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
    canUpload,
  };
}
