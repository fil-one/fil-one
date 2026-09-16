// Minting a customer key on a region serving the `iam` access model.
//
// The key is bound to the caller's principal and carries nothing of its own:
// what it may do is whatever the bucket policies give the member at request
// time (fil-one/RFC#30). So there is no creator-authority cap to run, no
// permission set to record, and no bucket scope to keep. What stays the same
// as the scoped-key mint is everything about the credential's record: the
// deletion fence, the intent written before the vendor call, the row landing in
// one transaction with the completion and the role check, and the credential
// going back when the row does not land.

import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { CreatePrincipalAccessKeySchema, isSupportedRegion } from '@filone/shared';
import type { CreateAccessKeyResponse, ErrorResponse, S3Region } from '@filone/shared';
import { AuditSubjects, twoPhaseAudit, userActor } from './audit.ts';
import type { AuditCorrelation } from './audit.ts';
import { AccessKeyKeys, keyAttribution } from './dynamo-records.ts';
import type { AccessKeyRecord } from './dynamo-records.ts';
import { AccessKeyAlreadyExistsError, AccessKeyValidationError } from './errors.ts';
import type { IamMethods, IssuedMemberKey } from './iam-orchestrator.ts';
import {
  discardRecordedKey,
  discardUnrecordedKey,
  keyExceedsCurrentRole,
  mintConflictResponse,
  recordMintedKey,
  roleChangedResponse,
} from './key-mint.ts';
import type { KeyMinter, MintedKey } from './key-mint.ts';
import { listOrgAccessKeys } from './member-keys.ts';
import { isOrgDeleting } from './org-profile.ts';
import { parseJsonBody } from './parse-json-body.ts';
import {
  accountDeletedResponse,
  ResponseBuilder,
  tenantNotReadyResponse,
} from './response-builder.ts';
import { getOrchestratorForRegion } from './service-orchestrator-registry.ts';
import type { IamOrchestrator } from './service-orchestrator.ts';
import type { AuthenticatedEvent } from './user-context.ts';
import { getUserInfo, getVerifiedEmail } from './user-context.ts';

/**
 * The `iam` orchestrator a create request is for, when it names a region that
 * mints principal-bound keys; undefined otherwise.
 *
 * Read off the raw body ahead of validation, because the two request shapes
 * have different schemas and the region decides which one applies. A body
 * that is not JSON, or names no supported region, is left to the scoped-key
 * path, whose schema answers the 400.
 */
export function principalKeyOrchestrator(rawBody: string | undefined): IamOrchestrator | undefined {
  try {
    const region = (JSON.parse(rawBody ?? '{}') as { region?: unknown }).region;
    if (typeof region !== 'string' || !isSupportedRegion(region, process.env.FILONE_STAGE!)) {
      return undefined;
    }
    const orchestrator = getOrchestratorForRegion(region);
    return orchestrator.accessModel === 'iam' ? orchestrator : undefined;
  } catch {
    return undefined;
  }
}

/** POST /api/access-keys on an `iam` region. */
export async function mintPrincipalKey(
  event: AuthenticatedEvent,
  orchestrator: IamOrchestrator,
): Promise<APIGatewayProxyStructuredResultV2> {
  const parsed = parseJsonBody(event.body, CreatePrincipalAccessKeySchema);
  if ('error' in parsed) return parsed.error;
  const { keyName, region } = parsed.data;
  const expiresAt = parsed.data.expiresAt ?? null;

  const { orgId, userId } = getUserInfo(event);
  const creatorEmail = getVerifiedEmail(event);
  const actor = userActor({ userId, email: creatorEmail });
  // The row asserts its holder can still mint; a principal-bound key has no
  // permissions to compare, so `canRetainAccessKey` asks only that.
  const minter: KeyMinter = { orgId, userId, key: { principalId: userId } };

  if (await isOrgDeleting(orgId, { consistent: true })) return accountDeletedResponse();

  const tenantId = await orchestrator.ensureTenantReady(orgId);
  if (!tenantId) return tenantNotReadyResponse();

  if (await orgShowsKeyName({ orgId, keyName, region })) return duplicateKeyNameResponse();

  const mint = await twoPhaseAudit({
    type: 'key.created',
    mode: 'fail-closed',
    actor,
    orgId,
    subject: AuditSubjects.org(orgId),
    details: { keyKind: 's3', keyName, region },
  });

  const issue = await issueAtVendor({
    iam: orchestrator.iam,
    tenantId,
    userId,
    keyName,
    expiresAt,
    mint,
  });
  if ('response' in issue) return issue.response;
  const { issued } = issue;

  const minted: MintedKey = {
    keyId: issued.id,
    accessKeyId: issued.accessKeyId,
    keyName,
    region,
    orchestrator,
    tenantId,
  };
  const row = principalKeyRow({ orgId, region, keyName, issued, expiresAt, userId, creatorEmail });

  const record = await recordMintedKey({ row, mint, minter });
  if (!record.recorded) {
    await discardUnrecordedKey({ minted, mint, minter });
    return record.reason === 'minter_role_changed' ? roleChangedResponse() : mintConflictResponse();
  }
  if (await keyExceedsCurrentRole(minter)) {
    await discardRecordedKey({ minted, minter, actor });
    return roleChangedResponse();
  }

  return new ResponseBuilder()
    .status(201)
    .body<CreateAccessKeyResponse>({
      id: issued.id,
      keyName,
      accessKeyId: issued.accessKeyId,
      secretAccessKey: issued.accessKeySecret,
      createdAt: issued.createdAt,
      principalId: issued.principalId,
    })
    .build();
}

/**
 * Whether the org already lists a key under this name in this region. The
 * console keeps names unique per region across the whole org, as it does for
 * scoped keys, even though the storage system scopes a principal-bound key's
 * name to its principal.
 */
async function orgShowsKeyName({
  orgId,
  keyName,
  region,
}: {
  orgId: string;
  keyName: string;
  region: string;
}): Promise<boolean> {
  const keys = await listOrgAccessKeys(orgId);
  return keys.some((key) => key.keyName === keyName && key.region === region);
}

/**
 * Sync the principal and mint the key, or answer for the vendor's refusal.
 *
 * The principal write is idempotent: the member's first key creates it, and a
 * later one revives it if it was removed. A duplicate name closes the intent
 * as a failure and answers 409; unlike the scoped-key path there is no recovery
 * by name, because a principal-bound key's name is unique only within its
 * principal. Anything else leaves the intent dangling on purpose: nobody knows
 * whether a credential exists, which is what the operator needs to see.
 */
async function issueAtVendor({
  iam,
  tenantId,
  userId,
  keyName,
  expiresAt,
  mint,
}: {
  iam: IamMethods;
  tenantId: string;
  userId: string;
  keyName: string;
  expiresAt: string | null;
  mint: AuditCorrelation<'key.created'>;
}): Promise<{ issued: IssuedMemberKey } | { response: APIGatewayProxyStructuredResultV2 }> {
  try {
    await iam.syncMember(tenantId, userId);
    return { issued: await iam.issueMemberKey(tenantId, userId, { keyName, expiresAt }) };
  } catch (err) {
    if (err instanceof AccessKeyAlreadyExistsError) {
      await mint.complete({ outcome: 'failed' });
      return { response: duplicateKeyNameResponse() };
    }
    if (err instanceof AccessKeyValidationError) {
      await mint.complete({ outcome: 'failed' });
      return {
        response: new ResponseBuilder()
          .status(400)
          .body<ErrorResponse>({ message: err.message })
          .build(),
      };
    }
    throw err;
  }
}

/** The row: the credential's identity, the principal, and who asked. No permission set. */
function principalKeyRow({
  orgId,
  region,
  keyName,
  issued,
  expiresAt,
  userId,
  creatorEmail,
}: {
  orgId: string;
  region: S3Region;
  keyName: string;
  issued: IssuedMemberKey;
  expiresAt: string | null;
  userId: string;
  creatorEmail: string | undefined;
}): AccessKeyRecord {
  return {
    pk: AccessKeyKeys.orgPk(orgId),
    sk: AccessKeyKeys.keySk(issued.id),
    keyName,
    accessKeyId: issued.accessKeyId,
    createdAt: issued.createdAt,
    status: 'active',
    region,
    principalId: issued.principalId,
    ...(expiresAt ? { expiresAt } : {}),
    ...keyAttribution({ userId, creatorEmail }),
  };
}

function duplicateKeyNameResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({ message: 'An access key with this name already exists' })
    .build();
}
