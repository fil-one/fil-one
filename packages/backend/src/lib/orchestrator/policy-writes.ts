// The retry rule fil-one/RFC#30 sets for policy and principal writes, and a new
// bucket's first policy write.

import pRetry from 'p-retry';
import type { S3Client } from '@aws-sdk/client-s3';
import type { BucketPolicy } from '@filone/shared';
import { PolicyConflictError, PolicyPublishError } from '../errors.ts';
import { putBucketPolicy } from '../s3-bucket-operations.ts';

const IAM_WRITE_RETRY = { retries: 2, minTimeout: 200, maxTimeout: 1000 } as const;

/**
 * True for the answers fil-one/RFC#30 documents as "retry the same request".
 * A stale precondition is never retried, because the caller must read the
 * current document first, and a refused document never succeeds on a repeat.
 */
function isRetryableWriteError(error: unknown): boolean {
  return error instanceof PolicyConflictError || error instanceof PolicyPublishError;
}

export function withWriteRetry<T>(run: () => Promise<T>): Promise<T> {
  return pRetry(run, {
    ...IAM_WRITE_RETRY,
    shouldRetry: ({ error }) => isRetryableWriteError(error),
  });
}

/**
 * A new bucket's first policy, written once the bucket exists (fil-one/RFC#30,
 * "Bucket creation") and refused if one is already stored.
 */
export async function putFirstBucketPolicy(
  s3: S3Client,
  bucketName: string,
  policy: BucketPolicy,
): Promise<void> {
  await withWriteRetry(() => putBucketPolicy(s3, bucketName, policy, { ifNoneMatch: '*' }));
}
