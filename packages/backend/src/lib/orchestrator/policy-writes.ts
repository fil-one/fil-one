// The retry rule fil-one/RFC#30 sets for policy and principal writes.

import type { S3Client } from '@aws-sdk/client-s3';
import pRetry from 'p-retry';
import type { BucketPolicy } from '@filone/shared';
import { BucketPolicyWriteError, PolicyConflictError, PolicyPublishError } from '../errors.ts';
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
 * Writes a bucket's first policy, right after the bucket is created. Refused if
 * one is already stored (fil-one/RFC#30, "Bucket creation"). The bucket exists by
 * the time this runs, so any failure arrives as a {@link BucketPolicyWriteError}
 * carrying the write's own error.
 */
export async function writeFirstBucketPolicy(
  s3: S3Client,
  bucketName: string,
  policy: BucketPolicy,
): Promise<void> {
  try {
    await withWriteRetry(() => putBucketPolicy(s3, bucketName, policy, { ifNoneMatch: '*' }));
  } catch (cause) {
    throw new BucketPolicyWriteError(bucketName, { cause });
  }
}
