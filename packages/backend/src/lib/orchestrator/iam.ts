// The `iam` arm of createFilOneOrchestrator (fil-one/RFC#30): principals and
// principal-bound keys over the Management API, bucket policies over S3 with
// the tenant's console key. Split from orchestrator.ts so each file stays
// about one half of the contract.

import pRetry from 'p-retry';
import type { S3Client } from '@aws-sdk/client-s3';
import type { BucketPolicy, MemberBucketAccess } from '@filone/shared';
import {
  deleteTenantsByTenantIdPrincipalsByPrincipalId,
  getTenantsByTenantIdPrincipalsByPrincipalIdAccess,
  getTenantsByTenantIdPrincipalsByPrincipalIdPolicies,
  putTenantsByTenantIdPrincipalsByPrincipalId,
  type Client,
} from '@filone/orchestrator-client';
import {
  PolicyConflictError,
  PolicyPublishError,
  PolicyValidationError,
  PrincipalNotFoundError,
} from '../errors.ts';
import type { IamMethods, MemberPolicy, StoredBucketPolicy } from '../iam-orchestrator.ts';
import type { OrchestratorRequestOptions } from '../service-orchestrator.ts';
import { deleteBucketPolicy, getBucketPolicy, putBucketPolicy } from '../s3-bucket-operations.ts';
import { createS3Client, type S3ClientContext } from '../s3-client.ts';
import { extractApiMessage } from './api-message.ts';

/**
 * The two answers the RFC documents as "retry the same request": a lock
 * timeout (409 on the management API, OperationAborted over S3), and a 500
 * after the storage system published revocations but committed nothing. A
 * stale precondition is never retried, because the caller must read the
 * current document first, and a refused document never succeeds on a repeat.
 */
const IAM_WRITE_RETRY = { retries: 2, minTimeout: 200, maxTimeout: 1000 } as const;

function retryableWrite(error: unknown): boolean {
  return error instanceof PolicyConflictError || error instanceof PolicyPublishError;
}

function withWriteRetry<T>(run: () => Promise<T>): Promise<T> {
  return pRetry(run, { ...IAM_WRITE_RETRY, shouldRetry: ({ error }) => retryableWrite(error) });
}

/** What the generated SDK hands back; only the fields read here. */
interface SdkResult<T> {
  data?: T;
  error?: unknown;
  /** Absent when the request never reached the network. */
  response?: { status: number; headers?: { get(name: string): string | null } };
}

/** A failed principal route, by status. */
function principalFailure(
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

/** Where the S3 client context for a tenant comes from: the orchestrator itself. */
export interface S3ContextSource {
  getS3ClientContext(tenantId: string, opts?: OrchestratorRequestOptions): Promise<S3ClientContext>;
}

interface IamContext {
  client: Client;
  orchestratorId: string;
  /** An S3 client signing as the tenant's console key on this region. */
  s3: (tenantId: string) => Promise<ReturnType<typeof createS3Client>>;
}

/** The message for an answer no mapping names; the upstream body rides as the cause. */
function failed(ctx: IamContext, what: string, tenantId: string): string {
  return `Failed to ${what} for ${ctx.orchestratorId} tenant ${tenantId}`;
}

export function buildIamMethods(
  client: Client,
  orchestratorId: string,
  source: S3ContextSource,
): IamMethods {
  const ctx: IamContext = {
    client,
    orchestratorId,
    s3: async (tenantId) => createS3Client(await source.getS3ClientContext(tenantId)),
  };
  return {
    ...buildPrincipalMethods(ctx),
    ...buildPolicyMethods(ctx),
  };
}

function buildPrincipalMethods(
  ctx: IamContext,
): Pick<
  IamMethods,
  'syncMember' | 'removeMember' | 'listBucketPoliciesForMember' | 'resolveMemberAccess'
> {
  const { client } = ctx;
  return {
    async syncMember(tenantId, userId) {
      await withWriteRetry(async () => {
        const result = await putTenantsByTenantIdPrincipalsByPrincipalId({
          client,
          path: { tenantId, principalId: userId },
          throwOnError: false,
        });
        if (result.error) {
          throw principalFailure(
            result,
            userId,
            failed(ctx, `create principal "${userId}"`, tenantId),
          );
        }
      });
    },

    async removeMember(tenantId, userId) {
      await withWriteRetry(async () => {
        const result = await deleteTenantsByTenantIdPrincipalsByPrincipalId({
          client,
          path: { tenantId, principalId: userId },
          throwOnError: false,
        });
        // 204 covers a principal that is already gone; a 404 is the tenant.
        if (result.error) {
          throw principalFailure(
            result,
            userId,
            failed(ctx, `remove principal "${userId}"`, tenantId),
          );
        }
      });
    },

    async listBucketPoliciesForMember(tenantId, userId): Promise<MemberPolicy[]> {
      const result = await getTenantsByTenantIdPrincipalsByPrincipalIdPolicies({
        client,
        path: { tenantId, principalId: userId },
        throwOnError: false,
      });
      if (result.error || !result.data) {
        throw principalFailure(
          result,
          userId,
          failed(ctx, `list the policies naming "${userId}"`, tenantId),
        );
      }
      return result.data.items.map((item) => ({
        bucketName: item.bucketName,
        policy: item.policy as BucketPolicy,
      }));
    },

    async resolveMemberAccess(tenantId, userId): Promise<MemberBucketAccess[]> {
      const result = await getTenantsByTenantIdPrincipalsByPrincipalIdAccess({
        client,
        path: { tenantId, principalId: userId },
        throwOnError: false,
      });
      if (result.error || !result.data) {
        throw principalFailure(
          result,
          userId,
          failed(ctx, `resolve the access of "${userId}"`, tenantId),
        );
      }
      return result.data.buckets.map((bucket) => ({
        bucketName: bucket.name,
        actions: bucket.actions as MemberBucketAccess['actions'],
      }));
    },
  };
}

/**
 * A new bucket's first policy, written once the bucket exists (fil-one/RFC#30,
 * "Bucket creation") and refused if one is already stored. Called from
 * `createBucket` with the client that created the bucket.
 */
export function putFirstBucketPolicy(
  s3: S3Client,
  bucketName: string,
  policy: BucketPolicy,
): Promise<{ etag: string }> {
  return withWriteRetry(() => putBucketPolicy(s3, bucketName, policy, { ifNoneMatch: '*' }));
}

function buildPolicyMethods(
  ctx: IamContext,
): Pick<IamMethods, 'getBucketPolicy' | 'putBucketPolicy' | 'deleteBucketPolicy'> {
  return {
    async getBucketPolicy(tenantId, bucketName): Promise<StoredBucketPolicy | null> {
      // The gateway's document shape is the shared one, field for field.
      return getBucketPolicy(await ctx.s3(tenantId), bucketName);
    },

    async putBucketPolicy(tenantId, bucketName, policy, precondition) {
      const s3 = await ctx.s3(tenantId);
      return withWriteRetry(() => putBucketPolicy(s3, bucketName, policy, precondition));
    },

    async deleteBucketPolicy(tenantId, bucketName, precondition) {
      const s3 = await ctx.s3(tenantId);
      await withWriteRetry(() => deleteBucketPolicy(s3, bucketName, precondition));
    },
  };
}
