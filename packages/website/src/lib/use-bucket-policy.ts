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
 * The read runs only for a caller holding `buckets.policy_manage` on an `iam`
 * region. Otherwise `isAvailable` is false and `snapshot` is `undefined`; a
 * bucket with no policy reads as `null`, so `hasLoadFailed` means only that the
 * request failed.
 *
 * A successful write caches the new snapshot and invalidates the bucket's access
 * keys, whose effective permissions follow the policy.
 */
export function useBucketPolicy(bucketName: string, region: S3Region) {
  const queryClient = useQueryClient();
  const canManagePolicy = useHasPermission('buckets.policy_manage');
  const isAvailable = canManagePolicy && isIamRegion(region);
  const policyQueryKey = queryKeys.bucketPolicy(bucketName, region);

  const query = useQuery({
    queryKey: policyQueryKey,
    enabled: isAvailable,
    staleTime: LIST_STALE_TIME,
    gcTime: LIST_GC_TIME,
    queryFn: () => getBucketPolicy(bucketName, region),
  });

  function cacheWrittenPolicy(snapshot: BucketPolicySnapshot | null) {
    queryClient.setQueryData<BucketPolicySnapshot | null>(policyQueryKey, snapshot);
    void queryClient.invalidateQueries({ queryKey: policyQueryKey });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.bucketAccessKeys(bucketName, region),
    });
  }

  const save = useMutation({
    mutationFn: ({ policy, etag }: { policy: BucketPolicy; etag?: string }) =>
      putBucketPolicy(bucketName, region, { policy, etag }),
    onSuccess: (written, { policy }) => cacheWrittenPolicy({ policy, etag: written.etag }),
  });

  const remove = useMutation({
    mutationFn: ({ etag }: { etag: string }) => deleteBucketPolicy(bucketName, region, etag),
    onSuccess: () => cacheWrittenPolicy(null),
  });

  return {
    isAvailable,
    // react-query keeps serving a disabled query's cached data, so a caller who
    // loses access mid-session must not keep seeing the policy.
    snapshot: isAvailable ? query.data : undefined,
    // A disabled query stays pending forever, which is not loading.
    isLoading: isAvailable && query.isPending,
    hasLoadFailed: isAvailable && query.isError,
    errorMessage: query.error instanceof Error ? query.error.message : undefined,
    refetch: () => query.refetch(),
    save,
    remove,
    isWriting: save.isPending || remove.isPending,
    /** The last save or delete lost to another writer. Clears on the next attempt. */
    hasConflict: isPolicyConflict(save.error) || isPolicyConflict(remove.error),
  };
}
