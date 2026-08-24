import { useCallback, useState } from 'react';
import type { S3Region } from '@filone/shared';
import { useToast } from '../components/Toast/index.js';
import { batchPresign } from './use-presign.js';
import { executePresignedUrl } from './aurora-s3.js';

export type UseObjectActionsOptions = {
  bucketName: string;
  region: S3Region;
  onDeleted?: (key: string, versionId?: string) => void;
};

/** A single object (or a specific version of one) targeted by a delete. */
export type ObjectDeleteTarget = { key: string; versionId?: string };

/** The presign endpoint accepts at most 10 operations per request. */
const PRESIGN_BATCH_SIZE = 10;

export function useObjectActions({ bucketName, region, onDeleted }: UseObjectActionsOptions) {
  const { toast } = useToast();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);

  const deleteObject = useCallback(
    async (key: string, versionId?: string) => {
      setDeleting(key);
      try {
        const { items } = await batchPresign(region, [
          { op: 'deleteObject', bucket: bucketName, key, ...(versionId && { versionId }) },
        ]);
        await executePresignedUrl(items[0].url, items[0].method);
        toast.success('Object deleted');
        onDeleted?.(key, versionId);
      } catch (err) {
        console.error('Failed to delete object:', err);
        toast.error(err instanceof Error ? err.message : 'Failed to delete object');
      } finally {
        setDeleting(null);
      }
    },
    [bucketName, region, toast, onDeleted],
  );

  /**
   * Delete several objects (or versions) in one go. Presign requests are capped
   * at 10 ops each, so targets are chunked; every chunk is attempted even if an
   * earlier one fails, and the toast reports the partial outcome.
   */
  const deleteObjects = useCallback(
    async (targets: ObjectDeleteTarget[]) => {
      if (targets.length === 0) return;
      setBulkDeleting(true);
      let deleted = 0;
      try {
        for (let i = 0; i < targets.length; i += PRESIGN_BATCH_SIZE) {
          const chunk = targets.slice(i, i + PRESIGN_BATCH_SIZE);
          try {
            const { items } = await batchPresign(
              region,
              chunk.map((target) => ({
                op: 'deleteObject' as const,
                bucket: bucketName,
                key: target.key,
                ...(target.versionId && { versionId: target.versionId }),
              })),
            );
            const results = await Promise.allSettled(
              items.map((item) => executePresignedUrl(item.url, item.method)),
            );
            results.forEach((result, idx) => {
              if (result.status === 'rejected') {
                console.error('Failed to delete object:', chunk[idx].key, result.reason);
                return;
              }
              deleted += 1;
              onDeleted?.(chunk[idx].key, chunk[idx].versionId);
            });
          } catch (err) {
            console.error('Failed to delete objects:', err);
          }
        }
      } finally {
        setBulkDeleting(false);
      }

      if (deleted === targets.length) {
        toast.success(`${deleted} ${deleted === 1 ? 'object' : 'objects'} deleted`);
      } else if (deleted === 0) {
        toast.error('Failed to delete objects');
      } else {
        toast.error(`Deleted ${deleted} of ${targets.length} objects`);
      }
    },
    [bucketName, region, toast, onDeleted],
  );

  const downloadObject = useCallback(
    async (key: string, versionId?: string) => {
      setDownloading(key);
      try {
        const { items } = await batchPresign(region, [
          { op: 'getObject', bucket: bucketName, key, ...(versionId && { versionId }) },
        ]);
        window.open(items[0].url, '_blank', 'noopener,noreferrer');
        toast.success('Download started');
      } catch (err) {
        console.error('Failed to get download URL:', err);
        toast.error(err instanceof Error ? err.message : 'Failed to get download URL');
      } finally {
        setDownloading(null);
      }
    },
    [bucketName, region, toast],
  );

  const [generatingUrl, setGeneratingUrl] = useState(false);

  const generatePresignedUrl = useCallback(
    async (
      key: string,
      options: { versionId?: string; expiresIn?: number } = {},
    ): Promise<{ url: string; expiresAt: string } | undefined> => {
      const { versionId, expiresIn } = options;
      setGeneratingUrl(true);
      try {
        const { items } = await batchPresign(region, [
          {
            op: 'getObject',
            bucket: bucketName,
            key,
            ...(versionId && { versionId }),
            ...(expiresIn && { expiresIn }),
          },
        ]);
        return { url: items[0].url, expiresAt: items[0].expiresAt };
      } catch (err) {
        console.error('Failed to generate presigned URL:', err);
        toast.error(err instanceof Error ? err.message : 'Failed to generate presigned URL');
        return undefined;
      } finally {
        setGeneratingUrl(false);
      }
    },
    [bucketName, region, toast],
  );

  return {
    deleteObject,
    deleteObjects,
    downloadObject,
    generatePresignedUrl,
    deleting,
    bulkDeleting,
    downloading,
    generatingUrl,
  };
}
