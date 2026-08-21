import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { ListBucketsResponse } from '@filone/shared';
import { ApiErrorCode, DOCS_URL } from '@filone/shared';

import { Link as ExternalLink } from '../components/Link';
import { useToast } from '../components/Toast';
import { apiRequest } from './api.js';
import { queryKeys } from './query-client.js';

// Linked from the "bucket is not empty" toast, next to the thing it explains —
// the docs page covers emptying a bucket with the S3 CLI.
const EMPTY_BUCKET_DOCS_URL = `${DOCS_URL}/storage/objects#deleting-objects`;

// A non-empty bucket keeps its longer-lived toast open long enough to read the
// explanation and click through to the docs.
const NOT_EMPTY_TOAST_DURATION_MS = 12_000;

type Toast = ReturnType<typeof useToast>['toast'];

// S3 refuses to delete a bucket that still holds objects or object versions.
// That is a user-fixable problem, so say what to do and link the docs rather
// than passing the raw API message through.
function reportDeleteError(err: unknown, bucketName: string, toast: Toast) {
  if ((err as { code?: string }).code === ApiErrorCode.BUCKET_NOT_EMPTY) {
    toast.error(
      <>
        Bucket &ldquo;{bucketName}&rdquo; is not empty. Delete its objects and object versions first
        —{' '}
        <ExternalLink href={EMPTY_BUCKET_DOCS_URL} variant="accent">
          how to empty a bucket
        </ExternalLink>
      </>,
      { duration: NOT_EMPTY_TOAST_DURATION_MS },
    );
    return;
  }
  toast.error(err instanceof Error ? err.message : 'Failed to delete bucket');
}

/**
 * Bucket deletion, gated behind a confirm step since it's irreversible.
 * Returns the confirm-dialog state and the action to run once confirmed;
 * the caller owns rendering the dialog and triggering `requestDelete`.
 */
export function useDeleteBucket() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [pendingBucketName, setPendingBucketName] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (bucketName: string) =>
      apiRequest(`/buckets/${encodeURIComponent(bucketName)}`, { method: 'DELETE' }),
    onSuccess: (_, bucketName) => {
      // Optimistically remove from cache, then confirm with a background refetch
      queryClient.setQueryData<ListBucketsResponse>(queryKeys.buckets, (old) =>
        old ? { buckets: old.buckets.filter((b) => b.bucketName !== bucketName) } : old,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.buckets });
      void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
      toast.success(`Bucket "${bucketName}" deleted`);
    },
    onError: (err, bucketName) => reportDeleteError(err, bucketName, toast),
  });

  async function confirmDelete() {
    if (!pendingBucketName) return;
    try {
      await mutation.mutateAsync(pendingBucketName);
    } catch {
      // error handled by mutation.onError
    }
  }

  return {
    pendingBucketName,
    requestDelete: setPendingBucketName,
    cancelDelete: () => setPendingBucketName(null),
    confirmDelete,
  };
}
