// The `iam` arm of createFilOneOrchestrator: principals, bucket policies, and
// principal-bound keys over the Management API (fil-one/RFC#30). Split from
// orchestrator.ts so each file stays about one half of the contract.

import pRetry from 'p-retry';
import type { BucketPolicy, MemberBucketAccess } from '@filone/shared';
import {
  deleteTenantsByTenantIdBucketsByBucketNamePolicy,
  deleteTenantsByTenantIdPrincipalsByPrincipalId,
  getTenantsByTenantIdBucketsByBucketNamePolicy,
  getTenantsByTenantIdPrincipalsByPrincipalIdAccess,
  getTenantsByTenantIdPrincipalsByPrincipalIdPolicies,
  postTenantsByTenantIdAccessKeys,
  putTenantsByTenantIdBucketsByBucketNamePolicy,
  putTenantsByTenantIdPrincipalsByPrincipalId,
  type Client,
} from '@filone/orchestrator-client';
import {
  AccessKeyAlreadyExistsError,
  AccessKeyValidationError,
  BucketNotFoundError,
  PolicyConflictError,
  PolicyNotFoundError,
  PolicyPreconditionFailedError,
  PolicyPublishError,
  PolicyValidationError,
  PrincipalNotFoundError,
} from '../errors.ts';
import type {
  IamMethods,
  IssueMemberKeyOpts,
  IssuedMemberKey,
  MemberPolicy,
  PolicyPrecondition,
  StoredBucketPolicy,
} from '../iam-orchestrator.ts';
import { extractApiCode, extractApiMessage } from './api-message.ts';

/**
 * The two answers the RFC documents as "retry the same request": a 409 lock
 * timeout, and a 500 after the storage system published revocations but
 * committed nothing. A 412 is never retried, because the caller must read the
 * current document first, and a 422 never succeeds on a repeat.
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

/** The storage system's code for "bucket exists, policy does not". */
const POLICY_NOT_FOUND_CODE = 'PolicyNotFound';

/**
 * Matched exactly, on the code or on a bare message: a 404 whose message
 * merely mentions the policy route is a bucket that is not there.
 */
function isPolicyNotFound(error: unknown): boolean {
  return (
    extractApiCode(error) === POLICY_NOT_FOUND_CODE ||
    extractApiMessage(error) === POLICY_NOT_FOUND_CODE
  );
}

/**
 * A failed policy route, by status. `write` decides what a 500 means: on a
 * write it is a publish that failed before commit, which the caller retries; on
 * a read it is an ordinary upstream failure.
 */
function policyFailure(
  result: SdkResult<unknown>,
  bucketName: string,
  write: boolean,
  fallback: string,
): Error {
  const cause = result.error;
  switch (result.response?.status) {
    case 404:
      return isPolicyNotFound(cause)
        ? new PolicyNotFoundError(bucketName, { cause })
        : new BucketNotFoundError(bucketName, { cause });
    case 409:
      return new PolicyConflictError({ cause });
    case 412:
      return new PolicyPreconditionFailedError(bucketName, { cause });
    case 422:
      return new PolicyValidationError(
        extractApiMessage(cause) ?? 'The storage system refused the policy document.',
        { cause },
      );
    case 500:
      return write ? new PolicyPublishError({ cause }) : new Error(fallback, { cause });
    default:
      return new Error(fallback, { cause });
  }
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

/** The ETag a successful read or write must carry; its absence is a contract violation. */
function readEtag(result: SdkResult<unknown>, bucketName: string): string {
  const etag = result.response?.headers?.get('etag');
  if (!etag) {
    throw new Error(`The storage system answered for bucket "${bucketName}" without an ETag`);
  }
  return etag;
}

function preconditionHeaders(precondition: PolicyPrecondition): Record<string, string> {
  return 'ifMatch' in precondition
    ? { 'If-Match': precondition.ifMatch }
    : { 'If-None-Match': precondition.ifNoneMatch };
}

interface IamContext {
  client: Client;
  orchestratorId: string;
}

/** The message for an answer no mapping names; the upstream body rides as the cause. */
function failed(ctx: IamContext, what: string, tenantId: string): string {
  return `Failed to ${what} for ${ctx.orchestratorId} tenant ${tenantId}`;
}

export function buildIamMethods(client: Client, orchestratorId: string): IamMethods {
  const ctx = { client, orchestratorId };
  return {
    ...buildPrincipalMethods(ctx),
    ...buildPolicyMethods(ctx),
    issueMemberKey: (tenantId, userId, opts) => issueMemberKey(ctx, tenantId, userId, opts),
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
        etag: item.etag,
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

function buildPolicyMethods(
  ctx: IamContext,
): Pick<IamMethods, 'getBucketPolicy' | 'putBucketPolicy' | 'deleteBucketPolicy'> {
  const { client } = ctx;
  return {
    async getBucketPolicy(tenantId, bucketName): Promise<StoredBucketPolicy | null> {
      const result = await getTenantsByTenantIdBucketsByBucketNamePolicy({
        client,
        path: { tenantId, bucketName },
        throwOnError: false,
      });
      if (result.error || !result.data) {
        const failure = policyFailure(
          result,
          bucketName,
          false,
          failed(ctx, `read the policy of bucket "${bucketName}"`, tenantId),
        );
        if (failure instanceof PolicyNotFoundError) return null;
        throw failure;
      }
      // The contract's document shape is the shared one, field for field.
      return { policy: result.data as BucketPolicy, etag: readEtag(result, bucketName) };
    },

    async putBucketPolicy(tenantId, bucketName, policy, precondition) {
      return withWriteRetry(async () => {
        const result = await putTenantsByTenantIdBucketsByBucketNamePolicy({
          client,
          path: { tenantId, bucketName },
          headers: preconditionHeaders(precondition),
          body: policy,
          throwOnError: false,
        });
        if (result.error) {
          throw policyFailure(
            result,
            bucketName,
            true,
            failed(ctx, `write the policy of bucket "${bucketName}"`, tenantId),
          );
        }
        return { etag: readEtag(result, bucketName), created: result.response?.status === 201 };
      });
    },

    async deleteBucketPolicy(tenantId, bucketName, precondition) {
      await withWriteRetry(async () => {
        const result = await deleteTenantsByTenantIdBucketsByBucketNamePolicy({
          client,
          path: { tenantId, bucketName },
          headers: preconditionHeaders(precondition),
          throwOnError: false,
        });
        if (result.error) {
          throw policyFailure(
            result,
            bucketName,
            true,
            failed(ctx, `delete the policy of bucket "${bucketName}"`, tenantId),
          );
        }
      });
    },
  };
}

async function issueMemberKey(
  ctx: IamContext,
  tenantId: string,
  userId: string,
  opts: IssueMemberKeyOpts,
): Promise<IssuedMemberKey> {
  const result = await postTenantsByTenantIdAccessKeys({
    client: ctx.client,
    path: { tenantId },
    body: { name: opts.keyName, principalId: userId, expiresAt: opts.expiresAt ?? null },
    throwOnError: false,
  });
  if (result.error || !result.data) {
    throw memberKeyFailure(
      result,
      userId,
      failed(ctx, `create a key for principal "${userId}"`, tenantId),
    );
  }
  return {
    id: result.data.accessKeyId,
    accessKeyId: result.data.accessKeyId,
    accessKeySecret: result.data.secretAccessKey,
    createdAt: result.data.createdAt,
    principalId: result.data.principal ?? userId,
  };
}

/**
 * A refused principal-bound key. A 422 is one of two things the storage system
 * spells out in its message: a principal it does not have, or a name or expiry
 * it will not accept.
 */
function memberKeyFailure(
  result: SdkResult<unknown>,
  principalId: string,
  fallback: string,
): Error {
  const cause = result.error;
  switch (result.response?.status) {
    case 409:
      return new AccessKeyAlreadyExistsError({ cause });
    case 422: {
      const message = extractApiMessage(cause);
      return /principal/i.test(message ?? '')
        ? new PrincipalNotFoundError(principalId, { cause })
        : new AccessKeyValidationError(
            message ?? 'Invalid access key request. Check the key name and try again.',
            { cause },
          );
    }
    default:
      return new Error(fallback, { cause });
  }
}
