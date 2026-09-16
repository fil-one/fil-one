import { ApiErrorCode } from '@filone/shared';
import type {
  BucketPolicy,
  GetBucketPolicyResponse,
  PutBucketPolicyResponse,
  S3Region,
} from '@filone/shared';
import { apiRequest, errorCodeOf, errorStatusOf } from './api.js';

/**
 * Typed client functions for a bucket's policy on an `iam` region. Thin
 * wrappers over {@link apiRequest}, like the RAG and members clients beside
 * them, so the tab's query hooks stay free of paths and serialization.
 *
 * The policy travels with the ETag its next write must carry. The ETag rides
 * in the JSON rather than in `If-Match`, because the API names its allowed
 * headers one by one.
 */

/** A policy as read, with the validator the next write sends back. */
export type BucketPolicySnapshot = GetBucketPolicyResponse;

function policyPath(bucketName: string, region: S3Region, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({ region, ...extra });
  return `/buckets/${encodeURIComponent(bucketName)}/policy?${params.toString()}`;
}

/**
 * The bucket's policy, or null when the bucket has none yet.
 *
 * "No policy" is a legitimate state of a bucket the caller can read, so it is
 * data rather than an error: `isError` on the query keeps meaning the request
 * failed. A bucket that is not there still throws.
 */
export async function getBucketPolicy(
  bucketName: string,
  region: S3Region,
): Promise<BucketPolicySnapshot | null> {
  try {
    return await apiRequest<BucketPolicySnapshot>(policyPath(bucketName, region));
  } catch (err) {
    if (errorCodeOf(err) === ApiErrorCode.POLICY_NOT_FOUND) return null;
    throw err;
  }
}

/**
 * Create or replace the policy. `etag` is what the last read returned; absent,
 * the write creates the bucket's first policy and is refused if one exists.
 */
export function putBucketPolicy(
  bucketName: string,
  region: S3Region,
  body: { policy: BucketPolicy; etag?: string },
): Promise<PutBucketPolicyResponse> {
  return apiRequest<PutBucketPolicyResponse>(policyPath(bucketName, region), {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/** Remove the policy the caller read. */
export function deleteBucketPolicy(
  bucketName: string,
  region: S3Region,
  etag: string,
): Promise<void> {
  return apiRequest<void>(policyPath(bucketName, region, { etag }), { method: 'DELETE' });
}

/**
 * Whether a failed write lost to another writer: the policy changed since it
 * was read, and nothing was written. The remedy is to reload and edit again,
 * which is why the tab branches on this rather than on a status.
 */
export function isPolicyConflict(error: unknown): boolean {
  return errorCodeOf(error) === ApiErrorCode.POLICY_CONFLICT || errorStatusOf(error) === 409;
}
