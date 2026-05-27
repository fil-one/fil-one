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

export function useObjectActions({ bucketName, region, onDeleted }: UseObjectActionsOptions) {
  const { toast } = useToast();
  const [deleting, setDeleting] = useState<string | null>(null);
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
    downloadObject,
    generatePresignedUrl,
    deleting,
    downloading,
    generatingUrl,
  };
}
