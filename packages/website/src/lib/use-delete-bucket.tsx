import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { ListBucketsResponse, S3Region } from '@filone/shared';
import { ApiErrorCode, DOCS_URL } from '@filone/shared';

import { Link as ExternalLink } from '../components/Link';
import { useToast } from '../components/Toast';
import { apiRequest } from './api.js';
import { queryKeys } from './query-client.js';
import { useHasPermission } from './use-permissions.js';
import { usePermittedDialog } from './use-permitted-dialog.js';

// Linked from the "bucket is not empty" toast, next to the thing it explains —
// the docs page covers emptying a bucket with the S3 CLI.
const EMPTY_BUCKET_DOCS_URL = `${DOCS_URL}/storage/objects#deleting-objects`;

// A non-empty bucket keeps its longer-lived toast open long enough to read the
// explanation and click through to the docs.
const NOT_EMPTY_TOAST_DURATION_MS = 12_000;

type Toast = ReturnType<typeof useToast>['toast'];

/**
 * The bucket a delete is about. A bucket is served by exactly one region, and
 * that region's gateway is the only one that can delete it, so the region
 * travels with the name to the API.
 */
export interface DeletableBucket {
  bucketName: string;
  region: S3Region;
}

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
  // The confirmation goes with the Delete control it was opened from: a dialog
  // left on screen after a demotion still confirms the request the hidden
  // control exists to avoid.
  const [pendingBucket, setPendingBucket] = usePermittedDialog<DeletableBucket | null>(
    null,
    useHasPermission('buckets.delete'),
  );

  const mutation = useMutation({
    mutationFn: ({ bucketName, region }: DeletableBucket) =>
      apiRequest(
        `/buckets/${encodeURIComponent(bucketName)}?${new URLSearchParams({ region }).toString()}`,
        { method: 'DELETE' },
      ),
    onSuccess: (_, { bucketName, region }) => {
      // Optimistically remove from cache, then confirm with a background refetch. Spread `old`:
      // this updater owns `buckets` only, and rebuilding the object would drop
      // `unavailableRegions`, making the degraded-regions banner vanish on any delete.
      queryClient.setQueryData<ListBucketsResponse>(queryKeys.buckets, (old) =>
        old
          ? {
              ...old,
              buckets: old.buckets.filter(
                (b) => !(b.bucketName === bucketName && b.region === region),
              ),
            }
          : old,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.buckets });
      void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
      toast.success(`Bucket "${bucketName}" deleted`);
    },
    onError: (err, { bucketName }) => reportDeleteError(err, bucketName, toast),
  });

  async function confirmDelete() {
    if (!pendingBucket) return;
    try {
      await mutation.mutateAsync(pendingBucket);
    } catch {
      // error handled by mutation.onError
    }
  }

  return {
    pendingBucket,
    requestDelete: setPendingBucket,
    cancelDelete: () => setPendingBucket(null),
    confirmDelete,
  };
}
