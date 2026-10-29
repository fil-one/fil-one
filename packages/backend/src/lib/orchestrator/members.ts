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
import { PolicyPublishError, PolicyValidationError, PrincipalNotFoundError } from '../errors.ts';
import type { MemberBucketPolicy } from '../member-orchestrator.ts';
import type { OrchestratorRequestOptions } from '../service-orchestrator.ts';

/** A principal route's arguments: the Management API client, the orchestrator its errors name, the tenant and the member. */
export interface PrincipalRouteArgs {
  client: Client;
  orchestratorId: string;
  tenantId: string;
  userId: string;
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
    case 422:
      return new PolicyValidationError(
        extractApiMessage(cause) ?? 'The storage system refused the principal id.',
        { cause },
      );
    // The storage system committed nothing, and the same request may be sent
    // again: a 5xx, or no answer at all (the request never reached it).
    case 500:
    case 502:
    case 503:
    case 504:
    case undefined:
      return new PolicyPublishError({ cause });
    default:
      return new Error(fallback, { cause });
  }
}

/** The message for an answer no mapping names; the upstream body rides as the cause. */
function formatFailureMessage(orchestratorId: string, what: string, tenantId: string): string {
  return `Failed to ${what} for ${orchestratorId} tenant ${tenantId}`;
}

export async function syncPrincipal({
  client,
  orchestratorId,
  tenantId,
  userId,
}: PrincipalRouteArgs): Promise<void> {
  await withWriteRetry(async () => {
    const result = await putTenantsByTenantIdPrincipalsByPrincipalId({
      client: client,
      path: { tenantId, principalId: userId },
      throwOnError: false,
    });
    if (result.error) {
      throw toPrincipalError(
        result,
        userId,
        formatFailureMessage(orchestratorId, `create principal "${userId}"`, tenantId),
      );
    }
  });
}

export async function removePrincipal({
  client,
  orchestratorId,
  tenantId,
  userId,
}: PrincipalRouteArgs): Promise<void> {
  await withWriteRetry(async () => {
    const result = await deleteTenantsByTenantIdPrincipalsByPrincipalId({
      client: client,
      path: { tenantId, principalId: userId },
      throwOnError: false,
    });
    if (result.error) {
      const message = formatFailureMessage(
        orchestratorId,
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

export async function listPrincipalPolicies({
  client,
  orchestratorId,
  tenantId,
  userId,
}: PrincipalRouteArgs): Promise<MemberBucketPolicy[]> {
  const result = await getTenantsByTenantIdPrincipalsByPrincipalIdPolicies({
    client: client,
    path: { tenantId, principalId: userId },
    throwOnError: false,
  });
  if (isUnknownPrincipal(result)) {
    warnUnknownPrincipal(orchestratorId, tenantId, userId);
    return [];
  }
  if (result.error || !result.data) {
    throw toPrincipalError(
      result,
      userId,
      formatFailureMessage(orchestratorId, `list the policies naming "${userId}"`, tenantId),
    );
  }
  return result.data.items.map((item) => ({
    bucketName: item.bucketName,
    policy: item.policy as BucketPolicy,
  }));
}

export async function resolvePrincipalAccess({
  client,
  orchestratorId,
  tenantId,
  userId,
  opts,
}: PrincipalRouteArgs & { opts?: OrchestratorRequestOptions }): Promise<MemberBucketAccess[]> {
  const result = await getTenantsByTenantIdPrincipalsByPrincipalIdAccess({
    client: client,
    path: { tenantId, principalId: userId },
    throwOnError: false,
    signal: opts?.signal,
  });
  if (isUnknownPrincipal(result)) {
    warnUnknownPrincipal(orchestratorId, tenantId, userId);
    return [];
  }
  if (result.error || !result.data) {
    throw toPrincipalError(
      result,
      userId,
      formatFailureMessage(orchestratorId, `resolve the access of "${userId}"`, tenantId),
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
