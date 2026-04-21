import { useCallback, useState } from 'react';
import { useToast } from '../components/Toast/index.js';
import { batchPresign } from './use-presign.js';
import { executePresignedUrl } from './aurora-s3.js';

export type UseObjectActionsOptions = {
  bucketName: string;
  onDeleted?: (key: string) => void;
};

export function useObjectActions({ bucketName, onDeleted }: UseObjectActionsOptions) {
  const { toast } = useToast();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  const deleteObject = useCallback(
    async (key: string) => {
      setDeleting(key);
      try {
        const { items } = await batchPresign([{ op: 'deleteObject', bucket: bucketName, key }]);
        await executePresignedUrl(items[0].url, items[0].method);
        toast.success('Object deleted');
        onDeleted?.(key);
      } catch (err) {
        console.error('Failed to delete object:', err);
        toast.error(err instanceof Error ? err.message : 'Failed to delete object');
      } finally {
        setDeleting(null);
      }
    },
    [bucketName, toast, onDeleted],
  );

  const downloadObject = useCallback(
    async (key: string) => {
      setDownloading(key);
      try {
        const { items } = await batchPresign([{ op: 'getObject', bucket: bucketName, key }]);
        window.open(items[0].url, '_blank', 'noopener,noreferrer');
        toast.success('Download started');
      } catch (err) {
        console.error('Failed to get download URL:', err);
        toast.error(err instanceof Error ? err.message : 'Failed to get download URL');
      } finally {
        setDownloading(null);
      }
    },
    [bucketName, toast],
  );

  const [generatingUrl, setGeneratingUrl] = useState(false);

  const generatePresignedUrl = useCallback(
    async (key: string) => {
      setGeneratingUrl(true);
      try {
        const { items } = await batchPresign([{ op: 'getObject', bucket: bucketName, key }]);
        await navigator.clipboard.writeText(items[0].url);
        toast.success('Presigned URL copied to clipboard');
      } catch (err) {
        console.error('Failed to generate presigned URL:', err);
        toast.error(err instanceof Error ? err.message : 'Failed to generate presigned URL');
      } finally {
        setGeneratingUrl(false);
      }
    },
    [bucketName, toast],
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
