import { ApiErrorCode } from '@filone/shared';
import type { BucketPolicy, GetBucketPolicyResponse, S3Region } from '@filone/shared';
import { errorCodeOf, errorStatusOf, sendApiRequest } from './api.js';

/**
 * Typed client functions for a bucket's policy on an `iam` region.
 *
 * The policy's version travels as on S3: the `ETag` response header, sent back
 * in `If-Match`, or `If-None-Match: *` to create the first policy.
 */

/** A policy as read, with the ETag the next write sends back. */
export type BucketPolicySnapshot = GetBucketPolicyResponse & { etag: string };

function getPolicyPath(bucketName: string, region: S3Region) {
  const params = new URLSearchParams({ region });
  return `/buckets/${encodeURIComponent(bucketName)}/policy?${params.toString()}`;
}

function getRequiredEtag(response: Response): string {
  const etag = response.headers.get('ETag');
  if (!etag) throw new Error('The policy response carried no ETag');
  return etag;
}

/** The bucket's policy, or null when the bucket has none yet. A bucket that is not there still throws. */
export async function getBucketPolicy(
  bucketName: string,
  region: S3Region,
): Promise<BucketPolicySnapshot | null> {
  try {
    const response = await sendApiRequest(getPolicyPath(bucketName, region));
    const { policy } = (await response.json()) as GetBucketPolicyResponse;
    return { policy, etag: getRequiredEtag(response) };
  } catch (err) {
    if (errorCodeOf(err) === ApiErrorCode.POLICY_NOT_FOUND) return null;
    throw err;
  }
}

/**
 * Create or replace the policy. `etag` is what the last read returned; absent,
 * the write creates the bucket's first policy and is refused if one exists.
 */
export async function putBucketPolicy(
  bucketName: string,
  region: S3Region,
  { policy, etag }: { policy: BucketPolicy; etag?: string },
): Promise<{ etag: string }> {
  const response = await sendApiRequest(getPolicyPath(bucketName, region), {
    method: 'PUT',
    headers: etag ? { 'If-Match': etag } : { 'If-None-Match': '*' },
    body: JSON.stringify({ policy }),
  });
  return { etag: getRequiredEtag(response) };
}

/** Remove the policy the caller read. */
export async function deleteBucketPolicy(
  bucketName: string,
  region: S3Region,
  etag: string,
): Promise<void> {
  await sendApiRequest(getPolicyPath(bucketName, region), {
    method: 'DELETE',
    headers: { 'If-Match': etag },
  });
}

/**
 * Whether a failed write lost to another writer: the policy changed since it
 * was read (412), or the backend's policy write lock was held by another write
 * (409), and nothing was written. The remedy is to reload and edit again.
 */
export function isPolicyConflict(error: unknown): boolean {
  const status = errorStatusOf(error);
  return errorCodeOf(error) === ApiErrorCode.POLICY_CONFLICT || status === 409 || status === 412;
}
