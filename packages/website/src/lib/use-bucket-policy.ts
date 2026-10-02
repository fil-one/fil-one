import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BucketPolicy, S3Region } from '@filone/shared';

import { isIamRegion } from './access-model.js';
import {
  deleteBucketPolicy,
  getBucketPolicy,
  isPolicyConflict,
  putBucketPolicy,
} from './bucket-policy-api.js';
import type { BucketPolicySnapshot } from './bucket-policy-api.js';
import { LIST_GC_TIME, LIST_STALE_TIME, queryKeys } from './query-client.js';
import { useHasPermission } from './use-permissions.js';

/**
 * The bucket's policy and the two writes against it.
 *
 * The read runs only where it can answer: a caller holding
 * `buckets.policy_manage` on a region serving the `iam` model. Elsewhere the
 * query stays disabled and `snapshot` is `undefined`, which the page reads as
 * "no tab" rather than "no policy".
 *
 * A save writes the answer into the cache and invalidates the bucket's keys,
 * since a principal-bound key's row now reads "follows bucket policy". A save
 * that lost to another writer reports `conflict` rather than toasting: the tab
 * shows the conflict in place, beside a reload, and keeps the draft.
 */
export function useBucketPolicy(bucketName: string, region: S3Region) {
  const queryClient = useQueryClient();
  const mayManage = useHasPermission('buckets.policy_manage');
  const enabled = mayManage && isIamRegion(region);
  const key = queryKeys.bucketPolicy(bucketName, region);

  const query = useQuery({
    queryKey: key,
    enabled,
    staleTime: LIST_STALE_TIME,
    gcTime: LIST_GC_TIME,
    queryFn: () => getBucketPolicy(bucketName, region),
  });

  function afterWrite(snapshot: BucketPolicySnapshot | null) {
    queryClient.setQueryData<BucketPolicySnapshot | null>(key, snapshot);
    void queryClient.invalidateQueries({ queryKey: key });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.bucketAccessKeys(bucketName, region),
    });
  }

  const save = useMutation({
    mutationFn: ({ policy, etag }: { policy: BucketPolicy; etag?: string }) =>
      putBucketPolicy(bucketName, region, { policy, etag }),
    onSuccess: (written, { policy }) => afterWrite({ policy, etag: written.etag }),
  });

  const remove = useMutation({
    mutationFn: ({ etag }: { etag: string }) => deleteBucketPolicy(bucketName, region, etag),
    onSuccess: () => afterWrite(null),
  });

  return {
    enabled,
    // Read through `enabled`, not just the query: react-query keeps serving a
    // disabled query's cached rows, and a mid-session downgrade must not leave
    // the document on screen.
    snapshot: enabled ? query.data : undefined,
    // A disabled query stays pending forever, which is not "loading".
    loading: enabled && query.isPending,
    failed: enabled && query.isError,
    errorMessage: query.error instanceof Error ? query.error.message : undefined,
    refetch: () => query.refetch(),
    save,
    remove,
    saving: save.isPending || remove.isPending,
    /** The last save or delete lost to another writer. Clears on the next attempt. */
    conflict: isPolicyConflict(save.error) || isPolicyConflict(remove.error),
  };
}
