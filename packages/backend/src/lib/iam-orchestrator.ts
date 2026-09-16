// The `iam` half of the orchestrator interface: what a Forge region's Hilt
// offers once it serves principals and bucket policies (fil-one/RFC#30). Every
// method here is a management-API call under the partner key; none touches
// DynamoDB, and every one takes a `tenantId` the caller has already resolved.
//
// Principals are console user ids. The console holds no copy of any policy: it
// reads one under an ETag, edits it, and writes it back under that ETag, so a
// stale edit loses and nothing is written.

import type { BucketPolicy, MemberBucketAccess } from '@filone/shared';
import type { IssuedAccessKey } from './service-orchestrator.ts';

/** A stored policy and the validator its next write must carry. Opaque to callers. */
export interface StoredBucketPolicy {
  policy: BucketPolicy;
  etag: string;
}

/** A policy naming a principal, as the member detail view lists them. */
export interface MemberPolicy extends StoredBucketPolicy {
  bucketName: string;
}

/**
 * Exactly one of the two, by construction: `ifMatch` replaces the policy the
 * caller read, `ifNoneMatch` creates a bucket's first policy and is refused if
 * one exists.
 */
export type PolicyPrecondition = { ifMatch: string } | { ifNoneMatch: '*' };

/** A key bound to a principal: the credential plus the member it belongs to. */
export interface IssuedMemberKey extends IssuedAccessKey {
  principalId: string;
}

export interface IssueMemberKeyOpts {
  /** Unique within the principal, so two members may each hold a `laptop`. */
  keyName: string;
  expiresAt?: string | null;
}

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
   * Creates or replaces the policy under the precondition. Throws
   * {@link PolicyPreconditionFailedError} on a stale ETag with nothing written,
   * and {@link PolicyValidationError} when the storage system refuses the
   * document. Retries the two answers the RFC documents as retryable, a lock
   * timeout and a failed revocation publish, and nothing else.
   */
  putBucketPolicy(
    tenantId: string,
    bucketName: string,
    policy: BucketPolicy,
    precondition: PolicyPrecondition,
  ): Promise<{ etag: string; created: boolean }>;

  /** Deletes the policy the caller read. Same precondition and retry rules as the write. */
  deleteBucketPolicy(
    tenantId: string,
    bucketName: string,
    precondition: { ifMatch: string },
  ): Promise<void>;

  /** Every policy with a statement naming the member or everyone. */
  listBucketPoliciesForMember(tenantId: string, userId: string): Promise<MemberPolicy[]>;

  /**
   * The member's effective actions per bucket, computed by the storage system
   * from its own tables, so the answer is consistent with its last write.
   * Buckets the member cannot reach are absent.
   */
  resolveMemberAccess(tenantId: string, userId: string): Promise<MemberBucketAccess[]>;

  /**
   * Mints a key bound to the member's principal. The key carries no permissions
   * or bucket list: what it may do is whatever the policies give the member at
   * the time of each request. Throws {@link PrincipalNotFoundError} when the
   * member was never synced, and {@link AccessKeyAlreadyExistsError} on a
   * duplicate name for that principal.
   */
  issueMemberKey(
    tenantId: string,
    userId: string,
    opts: IssueMemberKeyOpts,
  ): Promise<IssuedMemberKey>;
}
