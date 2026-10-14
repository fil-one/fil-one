// The Management API orchestrator with bucket policies and members
// (fil-one/RFC#30): principals and principal-bound keys over the Management
// API, bucket policies over S3 with the tenant's console key.

import pRetry from 'p-retry';
import type { BucketPolicy, MemberBucketAccess } from '@filone/shared';
import {
  deleteTenantsByTenantIdPrincipalsByPrincipalId,
  getTenantsByTenantIdPrincipalsByPrincipalIdAccess,
  getTenantsByTenantIdPrincipalsByPrincipalIdPolicies,
  putTenantsByTenantIdPrincipalsByPrincipalId,
} from '@filone/orchestrator-client';
import {
  PolicyConflictError,
  PolicyPublishError,
  PolicyValidationError,
  PrincipalNotFoundError,
} from '../errors.ts';
import type {
  IfMatchPrecondition,
  PolicyPrecondition,
  StoredBucketPolicy,
} from '../bucket-policy-orchestrator.ts';
import type { MemberBucketPolicy } from '../member-orchestrator.ts';
import type { RegionOrchestrator, ServiceOrchestrator } from '../service-orchestrator.ts';
import { deleteBucketPolicy, getBucketPolicy, putBucketPolicy } from '../s3-bucket-operations.ts';
import { createS3Client } from '../s3-client.ts';
import { extractApiMessage } from './api-message.ts';
import { LegacyFilOneOrchestrator, type FilOneOrchestratorConfig } from './orchestrator.ts';

const IAM_WRITE_RETRY = { retries: 2, minTimeout: 200, maxTimeout: 1000 } as const;

/**
 * True for the answers fil-one/RFC#30 documents as "retry the same request".
 * A stale precondition is never retried, because the caller must read the
 * current document first, and a refused document never succeeds on a repeat.
 */
function isRetryableWriteError(error: unknown): boolean {
  return error instanceof PolicyConflictError || error instanceof PolicyPublishError;
}

function withWriteRetry<T>(run: () => Promise<T>): Promise<T> {
  return pRetry(run, {
    ...IAM_WRITE_RETRY,
    shouldRetry: ({ error }) => isRetryableWriteError(error),
  });
}

/** What the generated SDK hands back; only the fields read here. */
interface SdkResult<T> {
  data?: T;
  error?: unknown;
  /** Absent when the request never reached the network. */
  response?: { status: number; headers?: { get(name: string): string | null } };
}

/** A failed principal route, by status. */
function toPrincipalError(
  result: SdkResult<unknown>,
  principalId: string,
  fallback: string,
): Error {
  const cause = result.error;
  switch (result.response?.status) {
    case 404:
      return new PrincipalNotFoundError(principalId, { cause });
    case 409:
      return new PolicyConflictError({ cause });
    case 422:
      return new PolicyValidationError(
        extractApiMessage(cause) ?? 'The storage system refused the principal id.',
        { cause },
      );
    case 500:
      return new PolicyPublishError({ cause });
    default:
      return new Error(fallback, { cause });
  }
}

export function createFilOneOrchestrator(config: FilOneOrchestratorConfig): RegionOrchestrator {
  return config.accessModel === 'iam'
    ? new FilOneOrchestrator(config)
    : new LegacyFilOneOrchestrator(config);
}

class FilOneOrchestrator extends LegacyFilOneOrchestrator implements ServiceOrchestrator {
  async syncMember(tenantId: string, userId: string): Promise<void> {
    await withWriteRetry(async () => {
      const result = await putTenantsByTenantIdPrincipalsByPrincipalId({
        client: this.client,
        path: { tenantId, principalId: userId },
        throwOnError: false,
      });
      if (result.error) {
        throw toPrincipalError(
          result,
          userId,
          this.formatFailureMessage(`create principal "${userId}"`, tenantId),
        );
      }
    });
  }

  async removeMember(tenantId: string, userId: string): Promise<void> {
    await withWriteRetry(async () => {
      const result = await deleteTenantsByTenantIdPrincipalsByPrincipalId({
        client: this.client,
        path: { tenantId, principalId: userId },
        throwOnError: false,
      });
      if (result.error) {
        const message = this.formatFailureMessage(`remove principal "${userId}"`, tenantId);
        // A principal that is already gone answers 204, so a 404 means the
        // tenant is missing.
        if (result.response?.status === 404) {
          throw new Error(`${message}: the tenant does not exist`, { cause: result.error });
        }
        throw toPrincipalError(result, userId, message);
      }
    });
  }

  async listBucketPoliciesForMember(
    tenantId: string,
    userId: string,
  ): Promise<MemberBucketPolicy[]> {
    const result = await getTenantsByTenantIdPrincipalsByPrincipalIdPolicies({
      client: this.client,
      path: { tenantId, principalId: userId },
      throwOnError: false,
    });
    if (result.error || !result.data) {
      throw toPrincipalError(
        result,
        userId,
        this.formatFailureMessage(`list the policies naming "${userId}"`, tenantId),
      );
    }
    return result.data.items.map((item) => ({
      bucketName: item.bucketName,
      policy: item.policy as BucketPolicy,
    }));
  }

  async resolveMemberAccess(tenantId: string, userId: string): Promise<MemberBucketAccess[]> {
    const result = await getTenantsByTenantIdPrincipalsByPrincipalIdAccess({
      client: this.client,
      path: { tenantId, principalId: userId },
      throwOnError: false,
    });
    if (result.error || !result.data) {
      throw toPrincipalError(
        result,
        userId,
        this.formatFailureMessage(`resolve the access of "${userId}"`, tenantId),
      );
    }
    return result.data.buckets.map((bucket) => ({
      bucketName: bucket.name,
      actions: bucket.actions as MemberBucketAccess['actions'],
    }));
  }

  async getBucketPolicy(tenantId: string, bucketName: string): Promise<StoredBucketPolicy | null> {
    // The S3 document matches `BucketPolicy` in `@filone/shared`.
    return getBucketPolicy(await this.getTenantS3Client(tenantId), bucketName);
  }

  async putBucketPolicy(
    tenantId: string,
    bucketName: string,
    policy: BucketPolicy,
    precondition?: PolicyPrecondition,
  ): Promise<{ etag: string }> {
    const s3 = await this.getTenantS3Client(tenantId);
    return withWriteRetry(() => putBucketPolicy(s3, bucketName, policy, precondition));
  }

  async deleteBucketPolicy(
    tenantId: string,
    bucketName: string,
    precondition?: IfMatchPrecondition,
  ): Promise<void> {
    const s3 = await this.getTenantS3Client(tenantId);
    await withWriteRetry(() => deleteBucketPolicy(s3, bucketName, precondition));
  }

  /** An S3 client signing as the tenant's console key on this region. */
  private async getTenantS3Client(tenantId: string) {
    return createS3Client(await this.getS3ClientContext(tenantId));
  }

  /** The message for an answer no mapping names; the upstream body rides as the cause. */
  private formatFailureMessage(what: string, tenantId: string): string {
    return `Failed to ${what} for ${this.id} tenant ${tenantId}`;
  }
}
