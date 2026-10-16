// The bucket-policy part of the orchestrator interface (fil-one/RFC#30): the S3
// bucket policy operations, signed with the tenant's console key. None touches
// DynamoDB, and every one takes a `tenantId` the caller has already resolved.
//
// The console holds no copy of any policy: it reads one under an ETag, edits
// it, and writes it back under that ETag, so a stale edit loses and nothing is
// written.

import type { BucketPolicy } from '@filone/shared';

/** A stored policy and the validator its next write must carry. Opaque to callers. */
export interface StoredBucketPolicy {
  policy: BucketPolicy;
  etag: string;
}

/**
 * At most one of the two, by construction: `ifMatch` replaces the policy the
 * caller read, `ifNoneMatch` creates a bucket's first policy and is refused if
 * one exists. A write with neither is unconditional, as on S3.
 */
export type PolicyPrecondition =
  | { ifMatch: string; ifNoneMatch?: never }
  | { ifNoneMatch: '*'; ifMatch?: never };

/** The precondition a delete carries; a delete never creates. */
export type IfMatchPrecondition = { ifMatch: string };

/** Bucket policies, read and written over S3 with the tenant's console key. */
export interface BucketPolicyOrchestrator {
  /** The bucket's policy, or null when the bucket exists and has none. Throws {@link BucketNotFoundError} otherwise. */
  getBucketPolicy(tenantId: string, bucketName: string): Promise<StoredBucketPolicy | null>;

  /**
   * Creates or replaces the policy with `PutBucketPolicy` under the
   * precondition, if any, sent as a signed `If-Match` or `If-None-Match: *`
   * header.
   * Throws {@link PolicyPreconditionFailedError} on a stale ETag with nothing
   * written, and {@link PolicyValidationError} when the storage system refuses
   * the document (`MalformedPolicy`). Retries the two answers the RFC documents
   * as retryable, a lock timeout and a failed revocation publish, and nothing
   * else.
   */
  putBucketPolicy(
    tenantId: string,
    bucketName: string,
    policy: BucketPolicy,
    precondition?: PolicyPrecondition,
  ): Promise<{ etag: string }>;

  /** Deletes the policy with `DeleteBucketPolicy`. Same precondition and retry rules as the write, less `ifNoneMatch`. */
  deleteBucketPolicy(
    tenantId: string,
    bucketName: string,
    precondition?: IfMatchPrecondition,
  ): Promise<void>;
}
