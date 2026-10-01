// The member part of the orchestrator interface (fil-one/RFC#30): what Hilt,
// Forge's storage gateway, offers once it serves principals. The methods are
// management-API calls under the partner key. None touches DynamoDB, and every
// one takes a `tenantId` the caller has already resolved. Principals are
// console user ids.

import type { BucketPolicy, MemberBucketAccess } from '@filone/shared';
import type { OrchestratorRequestOptions } from './service-orchestrator.ts';

/** A policy naming a principal, as the member detail view lists them. */
export interface MemberBucketPolicy {
  bucketName: string;
  policy: BucketPolicy;
}

/** Members as principals at the storage system. */
export interface MemberOrchestrator {
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

  /** Every policy with a statement naming the member or everyone. */
  listBucketPoliciesForMember(tenantId: string, userId: string): Promise<MemberBucketPolicy[]>;

  /**
   * The member's effective actions per bucket, computed by the storage system
   * from its own tables, so the answer is consistent with its last write.
   * Buckets the member cannot access are absent.
   */
  resolveMemberAccess(
    tenantId: string,
    userId: string,
    opts?: OrchestratorRequestOptions,
  ): Promise<MemberBucketAccess[]>;
}
