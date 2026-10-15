// The Management API's principal routes (fil-one/RFC#30): members as
// principals at the storage system, and the two reads the storage system
// computes from the bucket policies naming them.

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
import type { MemberBucketPolicy } from '../member-orchestrator.ts';
import type { OrchestratorRequestOptions } from '../service-orchestrator.ts';

/** The Management API client the principal routes go to, and the orchestrator its errors name. */
export interface OrchestratorBackend {
  client: Client;
  orchestratorId: string;
}
import { extractApiMessage } from './api-message.ts';
import { withWriteRetry } from './policy-writes.ts';

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

/** The message for an answer no mapping names; the upstream body rides as the cause. */
function formatFailureMessage(orchestratorId: string, what: string, tenantId: string): string {
  return `Failed to ${what} for ${orchestratorId} tenant ${tenantId}`;
}

export async function syncPrincipal(
  backend: OrchestratorBackend,
  tenantId: string,
  userId: string,
): Promise<void> {
  await withWriteRetry(async () => {
    const result = await putTenantsByTenantIdPrincipalsByPrincipalId({
      client: backend.client,
      path: { tenantId, principalId: userId },
      throwOnError: false,
    });
    if (result.error) {
      throw toPrincipalError(
        result,
        userId,
        formatFailureMessage(backend.orchestratorId, `create principal "${userId}"`, tenantId),
      );
    }
  });
}

export async function removePrincipal(
  backend: OrchestratorBackend,
  tenantId: string,
  userId: string,
): Promise<void> {
  await withWriteRetry(async () => {
    const result = await deleteTenantsByTenantIdPrincipalsByPrincipalId({
      client: backend.client,
      path: { tenantId, principalId: userId },
      throwOnError: false,
    });
    if (result.error) {
      const message = formatFailureMessage(
        backend.orchestratorId,
        `remove principal "${userId}"`,
        tenantId,
      );
      // A principal that is already gone answers 204, so a 404 means the
      // tenant is missing.
      if (result.response?.status === 404) {
        throw new Error(`${message}: the tenant does not exist`, { cause: result.error });
      }
      throw toPrincipalError(result, userId, message);
    }
  });
}

export async function listPrincipalPolicies(
  backend: OrchestratorBackend,
  tenantId: string,
  userId: string,
): Promise<MemberBucketPolicy[]> {
  const result = await getTenantsByTenantIdPrincipalsByPrincipalIdPolicies({
    client: backend.client,
    path: { tenantId, principalId: userId },
    throwOnError: false,
  });
  if (isUnknownPrincipal(result)) {
    warnUnknownPrincipal(backend.orchestratorId, tenantId, userId);
    return [];
  }
  if (result.error || !result.data) {
    throw toPrincipalError(
      result,
      userId,
      formatFailureMessage(
        backend.orchestratorId,
        `list the policies naming "${userId}"`,
        tenantId,
      ),
    );
  }
  return result.data.items.map((item) => ({
    bucketName: item.bucketName,
    policy: item.policy as BucketPolicy,
  }));
}

export async function resolvePrincipalAccess(
  backend: OrchestratorBackend,
  tenantId: string,
  userId: string,
  requestOptions?: OrchestratorRequestOptions,
): Promise<MemberBucketAccess[]> {
  const result = await getTenantsByTenantIdPrincipalsByPrincipalIdAccess({
    client: backend.client,
    path: { tenantId, principalId: userId },
    throwOnError: false,
    signal: requestOptions?.signal,
  });
  if (isUnknownPrincipal(result)) {
    warnUnknownPrincipal(backend.orchestratorId, tenantId, userId);
    return [];
  }
  if (result.error || !result.data) {
    throw toPrincipalError(
      result,
      userId,
      formatFailureMessage(backend.orchestratorId, `resolve the access of "${userId}"`, tenantId),
    );
  }
  return result.data.buckets.map((bucket) => ({
    bucketName: bucket.name,
    actions: bucket.actions as MemberBucketAccess['actions'],
  }));
}

// A principal the storage system does not know (never registered, or removed)
// is named in no policy and reaches no bucket, so the reads answer that rather
// than failing the region.
function isUnknownPrincipal(result: SdkResult<unknown>): boolean {
  return result.response?.status === 404;
}

function warnUnknownPrincipal(orchestratorId: string, tenantId: string, userId: string): void {
  console.warn(`[${orchestratorId}] Principal "${userId}" is not known to tenant ${tenantId}`);
}
