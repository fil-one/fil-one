// Builds the body of the storage system's create-access-key request.

import type {
  CreateAccessKeyRequest,
  CreateServiceAccessKeyRequest,
} from '@filone/orchestrator-client';
import type { IssueAccessKeyOpts } from '../service-orchestrator.ts';
import { AccessKeyValidationError } from '../errors.ts';
import { toAccessKeyExpiryInstant } from '../access-key-expiry.ts';
import { buildPermissions } from './permissions.ts';

/**
 * A principal-bound key sends only its name, `principalId` and expiry; a
 * service key sends its permissions and bucket list.
 */
export function buildIssueAccessKeyRequestBody(
  keyOpts: IssueAccessKeyOpts,
): CreateAccessKeyRequest {
  const expiresAt = toAccessKeyExpiryInstant(keyOpts.expiresAt);
  if ('principalId' in keyOpts) {
    // The type forbids these; a non-literal object can still carry them, and
    // dropping them would mint a key the caller did not ask for. `bucketScope`
    // is a field of the create-key handler's request, not of these options,
    // so it arrives only when a caller spreads that request in.
    if (
      ['permissions', 'granularPermissions', 'buckets', 'bucketScope'].some((f) => f in keyOpts)
    ) {
      throw new AccessKeyValidationError(
        'A principal-bound key carries no permissions or buckets of its own.',
      );
    }
    return { name: keyOpts.keyName, principalId: keyOpts.principalId, expiresAt };
  }
  return {
    name: keyOpts.keyName,
    // buildPermissions only emits actions from the contract's enum.
    permissions: buildPermissions(
      keyOpts.permissions,
      keyOpts.granularPermissions,
    ) as CreateServiceAccessKeyRequest['permissions'],
    buckets: keyOpts.buckets ?? [],
    expiresAt,
  };
}

/** What a log line says about the key being created; it carries no secret. */
export function describeAccessKeyBody(body: CreateAccessKeyRequest): string {
  return 'principalId' in body
    ? `bound to principal "${body.principalId}"`
    : `with permissions [${body.permissions.join(', ')}] and bucket scopes [${body.buckets?.join(', ')}]`;
}
