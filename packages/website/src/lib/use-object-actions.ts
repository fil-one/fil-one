import { useCallback, useState } from 'react';
import { useToast } from '../components/Toast/index.js';
import { apiRequest } from './api.js';

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
        await apiRequest(
          `/buckets/${encodeURIComponent(bucketName)}/objects?key=${encodeURIComponent(key)}`,
          { method: 'DELETE' },
        );
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
        const data = await apiRequest<{ url: string }>(
          `/buckets/${encodeURIComponent(bucketName)}/objects/download?key=${encodeURIComponent(key)}`,
        );
        window.open(data.url, '_blank', 'noopener,noreferrer');
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
        const data = await apiRequest<{ url: string }>(
          `/buckets/${encodeURIComponent(bucketName)}/objects/download?key=${encodeURIComponent(key)}`,
        );
        await navigator.clipboard.writeText(data.url);
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
