import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ListBucketsResponse, S3Region } from '@filone/shared';
import { ApiErrorCode, DOCS_URL } from '@filone/shared';

import { Link as ExternalLink } from '../components/Link';
import { useToast } from '../components/Toast';
import { apiRequest } from './api.js';
import { executePresignedUrl, parseListObjectVersionsResponse } from './aurora-s3.js';
import { batchPresign } from './use-presign.js';
import { queryKeys } from './query-client.js';
import { useHasPermission } from './use-permissions.js';
import { usePermittedDialog } from './use-permitted-dialog.js';

// Linked from the "bucket is not empty" toast, next to the thing it explains:
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
        Bucket &ldquo;{bucketName}&rdquo; is not empty. Delete its objects and object versions
        first:{' '}
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

interface PendingDelete {
  bucketName: string;
  region: string;
}

/**
 * What the delete dialog knows about the bucket's contents. `unknown` is a
 * failed check: the dialog then offers the delete as before, and the server's
 * BUCKET_NOT_EMPTY refusal still stands behind it.
 */
export type BucketContents = 'checking' | 'empty' | 'not-empty' | 'unknown';

/**
 * Whether the bucket still holds anything S3 would refuse to delete it over.
 *
 * One ListObjectVersions entry is enough to answer, and it covers every bucket:
 * versions and delete markers in a versioned or suspended bucket, and plain
 * objects in one that never enabled versioning, which S3 reports as `null`
 * versions. The analytics count would be cheaper but is a daily sample, so it
 * can call a just-emptied bucket full or a just-filled one empty.
 */
async function bucketHoldsObjects(
  bucketName: string,
  region: S3Region,
  signal: AbortSignal,
): Promise<boolean> {
  const { items } = await batchPresign(
    region,
    [{ op: 'listObjectVersions', bucket: bucketName, maxKeys: 1 }],
    signal,
  );
  const response = await executePresignedUrl(items[0].url, items[0].method);
  return parseListObjectVersionsResponse(await response.text()).versions.length > 0;
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
  // The region travels with the name: a bucket is deleted in the region that
  // holds it, and the list mixes regions row by row.
  const [pending, setPending] = usePermittedDialog<PendingDelete | null>(
    null,
    useHasPermission('buckets.delete'),
  );

  // gcTime 0: every opening asks S3 afresh, so emptying a bucket on its own page
  // and coming back to delete it never meets a cached "not empty".
  const contentsQuery = useQuery({
    queryKey: queryKeys.bucketHoldsObjects(
      pending?.bucketName ?? '',
      (pending?.region ?? '') as S3Region,
    ),
    queryFn: ({ signal }) =>
      bucketHoldsObjects(pending!.bucketName, pending!.region as S3Region, signal),
    enabled: pending !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const contents: BucketContents = contentsQuery.isPending
    ? 'checking'
    : contentsQuery.isError
      ? 'unknown'
      : contentsQuery.data
        ? 'not-empty'
        : 'empty';

  const mutation = useMutation({
    mutationFn: ({ bucketName, region }: PendingDelete) =>
      apiRequest(
        `/buckets/${encodeURIComponent(bucketName)}?region=${encodeURIComponent(region)}`,
        { method: 'DELETE' },
      ),
    onSuccess: (_, { bucketName }) => {
      // Optimistically remove from cache, then confirm with a background refetch. Spread `old`:
      // this updater owns `buckets` only, and rebuilding the object would drop
      // `unavailableRegions`, making the degraded-regions banner vanish on any delete.
      queryClient.setQueryData<ListBucketsResponse>(queryKeys.buckets, (old) =>
        old ? { ...old, buckets: old.buckets.filter((b) => b.bucketName !== bucketName) } : old,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.buckets });
      void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
      toast.success(`Bucket "${bucketName}" deleted`);
    },
    onError: (err, { bucketName }) => reportDeleteError(err, bucketName, toast),
  });

  async function confirmDelete() {
    if (!pending) return;
    try {
      await mutation.mutateAsync(pending);
    } catch {
      // error handled by mutation.onError
    }
  }

  return {
    pendingBucket: pending,
    contents,
    requestDelete: (bucketName: string, region: string) => setPending({ bucketName, region }),
    cancelDelete: () => setPending(null),
    confirmDelete,
  };
}
