// The bucket-policy part of the orchestrator interface (fil-one/RFC#30): the S3
// bucket policy operations, signed with the tenant's console key. None touches
// DynamoDB, and every one takes a `tenantId` the caller has already resolved.
//
// The console holds no copy of any policy. Writes are unconditional and the
// last one wins, as on AWS (fil-one/RFC rfcs/2026-10-bucket-policy-writes-without-locks.md).

import type { BucketPolicy } from '@filone/shared';

/** Bucket policies, read and written over S3 with the tenant's console key. */
export interface BucketPolicyOrchestrator {
  /** The bucket's policy, or null when the bucket exists and has none. Throws {@link BucketNotFoundError} otherwise. */
  getBucketPolicy(tenantId: string, bucketName: string): Promise<BucketPolicy | null>;

  /**
   * Creates or replaces the policy with `PutBucketPolicy`.
   * Throws {@link PolicyValidationError} when the storage system refuses the
   * document (`MalformedPolicy`). Retries a failed revocation publish, the one
   * answer the RFC documents as retryable, and nothing else.
   */
  putBucketPolicy(tenantId: string, bucketName: string, policy: BucketPolicy): Promise<void>;

  /** Deletes the policy with `DeleteBucketPolicy`. Same retry rule as the write. */
  deleteBucketPolicy(tenantId: string, bucketName: string): Promise<void>;
}
