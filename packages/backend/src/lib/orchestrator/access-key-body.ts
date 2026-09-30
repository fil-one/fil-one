// The access-key create request as the storage system takes it. Shared by the
// two arms: the body's shape is the key's kind on both.

import type { CreateAccessKeyRequest } from '@filone/orchestrator-client';
import type { IssueAccessKeyOpts } from '../service-orchestrator.ts';
import { buildPermissions } from './permissions.ts';

/**
 * The create request in the storage system's shape, which is the key's kind: a
 * principal-bound key carries `principalId` and nothing of its own, a service
 * key its permissions and bucket list.
 */
export function accessKeyBody(keyOpts: IssueAccessKeyOpts): CreateAccessKeyRequest {
  const expiresAt = keyOpts.expiresAt ?? null;
  if ('principalId' in keyOpts) {
    return { name: keyOpts.keyName, principalId: keyOpts.principalId, expiresAt };
  }
  return {
    name: keyOpts.keyName,
    // buildPermissions only emits actions from the contract's enum.
    permissions: buildPermissions(
      keyOpts.permissions,
      keyOpts.granularPermissions,
    ) as CreateAccessKeyRequest['permissions'],
    buckets: keyOpts.buckets ?? [],
    expiresAt,
  };
}

/** What a log line says about the key being created; it carries no secret. */
export function describeAccessKeyBody(body: CreateAccessKeyRequest): string {
  return body.principalId
    ? `bound to principal "${body.principalId}"`
    : `with permissions [${body.permissions?.join(', ')}] and bucket scopes [${body.buckets?.join(', ')}]`;
}
