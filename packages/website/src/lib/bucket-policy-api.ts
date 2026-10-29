import { ApiErrorCode } from '@filone/shared';
import type { BucketPolicy, GetBucketPolicyResponse, S3Region } from '@filone/shared';
import { apiRequest, errorCodeOf } from './api.js';

/**
 * Typed client functions for a bucket's policy on an `iam` region. Writes are
 * unconditional and the last one wins, as on S3.
 */

/** A policy as read. */
export type BucketPolicySnapshot = GetBucketPolicyResponse;

function getPolicyPath(bucketName: string, region: S3Region) {
  const params = new URLSearchParams({ region });
  return `/buckets/${encodeURIComponent(bucketName)}/policy?${params.toString()}`;
}

/** The bucket's policy, or null when the bucket has none yet. A bucket that is not there still throws. */
export async function getBucketPolicy(
  bucketName: string,
  region: S3Region,
): Promise<BucketPolicySnapshot | null> {
  try {
    return await apiRequest<GetBucketPolicyResponse>(getPolicyPath(bucketName, region));
  } catch (err) {
    if (errorCodeOf(err) === ApiErrorCode.POLICY_NOT_FOUND) return null;
    throw err;
  }
}

/** Create or replace the policy. */
export async function putBucketPolicy(
  bucketName: string,
  region: S3Region,
  policy: BucketPolicy,
): Promise<void> {
  await apiRequest<void>(getPolicyPath(bucketName, region), {
    method: 'PUT',
    body: JSON.stringify({ policy }),
  });
}

/** Remove the policy. */
export async function deleteBucketPolicy(bucketName: string, region: S3Region): Promise<void> {
  await apiRequest<void>(getPolicyPath(bucketName, region), { method: 'DELETE' });
}
