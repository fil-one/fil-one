// The `iam` half of the orchestrator interface: what a Forge region's Hilt
// offers once it serves principals and bucket policies (fil-one/RFC#30). The
// principal methods are management-API calls under the partner key; the
// policy methods are the S3 bucket policy operations signed with the tenant's
// console key. None touches DynamoDB, and every one takes a `tenantId` the
// caller has already resolved.
//
// Principals are console user ids. The console holds no copy of any policy: it
// reads one under an ETag, edits it, and writes it back under that ETag, so a
// stale edit loses and nothing is written.

import type { BucketPolicy, MemberBucketAccess } from '@filone/shared';

/** A stored policy and the validator its next write must carry. Opaque to callers. */
export interface StoredBucketPolicy {
  policy: BucketPolicy;
  etag: string;
}

/** A policy naming a principal, as the member detail view lists them. */
export interface MemberPolicy {
  bucketName: string;
  policy: BucketPolicy;
}

/**
 * At most one of the two, by construction: `ifMatch` replaces the policy the
 * caller read, `ifNoneMatch` creates a bucket's first policy and is refused if
 * one exists. A write with neither is unconditional, as on S3.
 */
export type PolicyPrecondition =
  | { ifMatch: string; ifNoneMatch?: never }
  | { ifNoneMatch: '*'; ifMatch?: never };

export interface IamMethods {
  /**
   * Asserts the member exists as a principal, so a key can bind to it and a
   * statement can name it. Idempotent; carries no permissions. Revives a
   * removed principal with nothing attached.
   */
  syncMember(tenantId: string, userId: string): Promise<void>;

  /**
   * Removes the principal, every key bound to it, and every statement naming
   * it. Idempotent: a principal that is already gone is success.
   */
  removeMember(tenantId: string, userId: string): Promise<void>;

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
    precondition?: { ifMatch: string },
  ): Promise<void>;

  /** Every policy with a statement naming the member or everyone. */
  listBucketPoliciesForMember(tenantId: string, userId: string): Promise<MemberPolicy[]>;

  /**
   * The member's effective actions per bucket, computed by the storage system
   * from its own tables, so the answer is consistent with its last write.
   * Buckets the member cannot reach are absent.
   */
  resolveMemberAccess(tenantId: string, userId: string): Promise<MemberBucketAccess[]>;
}
