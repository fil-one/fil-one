import { QueryCommand, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import {
  ApiErrorCode,
  CreateAccessKeySchema,
  NO_ROLE,
  S3Region,
  auditKeyIdSuffix,
  canRetainAccessKey,
  excessKeyPermissions,
  isSupportedRegion,
} from '@filone/shared';
import type {
  AccessKeyPermissions,
  AuditActor,
  CreateAccessKeyRequest,
  CreateAccessKeyResponse,
  ErrorResponse,
  GranularPermission,
} from '@filone/shared';
import { Resource } from 'sst';
import { accessKeyMintSeqItem } from '../lib/access-key-mint-seq.ts';
import { AuditSubjects, twoPhaseAudit, userActor } from '../lib/audit.ts';
import { RevocationNotRecordedError, revokeAccessKey } from '../lib/key-revocation.ts';
import { resolveMembership } from '../lib/org-membership.ts';
import type { AuditCorrelation } from '../lib/audit.ts';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.ts';
import { AccessKeyAlreadyExistsError, AccessKeyValidationError } from '../lib/errors.ts';
import type { IssuedAccessKey, ServiceOrchestrator } from '../lib/service-orchestrator.ts';
import { getDynamoClient } from '../lib/ddb-client.ts';
import { isOrgDeleting } from '../lib/org-profile.ts';
import { parseJsonBody } from '../lib/parse-json-body.ts';
import {
  accountDeletedResponse,
  ResponseBuilder,
  tenantNotReadyResponse,
  unsupportedRegionResponse,
} from '../lib/response-builder.ts';
import { AccessKeyKeys, keyAttribution } from '../lib/dynamo-records.ts';
import { cancelledLabels, creatorRoleStillMintsCheck } from '../lib/membership-changes.ts';
import type { AccessKeyRecord } from '../lib/dynamo-records.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { authorize, requireOrgMembershipMiddleware } from '../middleware/authorize.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.ts';

// TODO: Refactor the handler, reducing its complexity and removing the ignore eslint directive.
// https://linear.app/filecoin-foundation/issue/FIL-320/refactor-create-access-key-handler
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const parsed = parseJsonBody(event.body, CreateAccessKeySchema);
  if ('error' in parsed) return parsed.error;

  const { keyName, permissions, granularPermissions, bucketScope, region } = parsed.data;
  const buckets = bucketScope === 'specific' ? (parsed.data.buckets ?? []) : undefined;
  const expiresAt = parsed.data.expiresAt ?? null;

  const denied = checkCreatorAuthority(event, parsed.data);
  if (denied) return denied;

  const { orgId, userId } = getUserInfo(event);
  // What the cap above admitted. The key row's write asserts the role on file
  // can still grant it, and the read after that write asks again.
  const creator = { orgId, userId, key: { permissions, granularPermissions } };
  const creatorEmail = getVerifiedEmail(event);
  const attribution = keyAttribution({ userId, creatorEmail });
  const actor = userActor({ userId, email: creatorEmail });

  if (!isSupportedRegion(region, process.env.FILONE_STAGE!)) {
    return unsupportedRegionResponse(region);
  }

  // Before ensureTenantReady: the key is minted upstream, so a fence checked
  // only at the DynamoDB write would leave a live credential behind.
  if (await isOrgDeleting(orgId, { consistent: true })) return accountDeletedResponse();

  const orchestrator = getOrchestratorForRegion(region);
  const tenantId = await orchestrator.ensureTenantReady(orgId);
  if (!tenantId) return tenantNotReadyResponse();

  // Fail-closed, and before the vendor: the credential is created at the storage
  // vendor before anything local is written, so no SigV4 key may come into
  // existence without a record that somebody asked for it. The intent cannot
  // name the key — the id comes back from the vendor — which is what makes a
  // dangling intent legible: a key was asked for by this name and no completion
  // followed. Both halves are filed under the org for the same reason.
  const mint = await twoPhaseAudit({
    type: 'key.created',
    mode: 'fail-closed',
    actor,
    orgId,
    subject: AuditSubjects.org(orgId),
    details: { keyKind: 's3', keyName, region },
  });

  let accessKey: IssuedAccessKey;
  try {
    accessKey = await orchestrator.issueAccessKey(tenantId, {
      keyName,
      permissions,
      granularPermissions,
      buckets,
      expiresAt,
    });
  } catch (err) {
    return await handleMintRefusal(err, {
      orgId,
      tenantId,
      keyName,
      region,
      orchestrator,
      attribution,
      mint,
      creator,
    });
  }

  const mintedKey: MintedKey = {
    keyId: accessKey.id,
    accessKeyId: accessKey.accessKeyId,
    keyName,
    region,
    orchestrator,
    tenantId,
  };

  const record = await recordMintedKey({
    row: {
      pk: AccessKeyKeys.orgPk(orgId),
      sk: AccessKeyKeys.keySk(accessKey.id),
      keyName,
      accessKeyId: accessKey.accessKeyId,
      createdAt: accessKey.createdAt,
      status: 'active',
      region,
      permissions,
      bucketScope,
      ...optionalKeyAttributes({ granularPermissions, buckets, expiresAt }),
      ...attribution,
    },
    minted: mintedKey,
    mintedKey: mint,
    creator,
  });
  if (!record.recorded) {
    await discardUnrecordedKey({ minted: mintedKey, mint, creator });
    return record.reason === 'creator_role_changed'
      ? creatorRoleChangedResponse()
      : mintConflictResponse();
  }

  if (await keyExceedsCurrentRole(creator)) {
    await discardRecordedKey({ minted: mintedKey, creator, actor });
    return creatorRoleChangedResponse();
  }

  return new ResponseBuilder()
    .status(201)
    .body<CreateAccessKeyResponse>({
      id: accessKey.id,
      keyName,
      accessKeyId: accessKey.accessKeyId,
      secretAccessKey: accessKey.accessKeySecret,
      createdAt: accessKey.createdAt,
    })
    .build();
}

/** The credential the vendor handed back, and where it lives. */
interface MintedKey {
  /** The orchestrator's id for the key, which is what `deleteAccessKey` takes. */
  keyId: string;
  accessKeyId: string;
  keyName: string;
  region: S3Region;
  orchestrator: ServiceOrchestrator;
  tenantId: string;
}

/** Who the cap was evaluated for, and the key it admitted. */
interface KeyCreator {
  orgId: string;
  userId: string;
  /** The permissions the requested key would carry. */
  key: AccessKeyPermissions;
}

/**
 * Whether the key row landed. When it did not, the credential is still live at
 * the vendor and the caller has to hand it back.
 *
 * `write_conflict` is DynamoDB refusing the whole transaction over contention on
 * the mint sequence, which every mint for this member writes and every narrowing
 * of their role asserts (`lib/access-key-mint-seq.ts`).
 */
type MintRecord =
  | { recorded: true }
  | { recorded: false; reason: 'creator_role_changed' | 'write_conflict' };

/**
 * Write the key's row and the completion event as one transaction, so the
 * record of a live credential cannot be the half that fails.
 *
 * Both mint paths land here — the ordinary one and the duplicate recovery — so
 * a key row and its event are written the same way whichever attempt produced
 * the credential.
 *
 * A row the creator's role no longer covers does not land, and the intent
 * stays open: the caller takes the credential back with
 * {@link discardUnrecordedKey}, which is what closes it.
 */
async function recordMintedKey({
  row,
  minted,
  mintedKey,
  creator,
  recovered,
}: {
  row: Record<string, unknown>;
  minted: MintedKey;
  mintedKey: AuditCorrelation<'key.created'>;
  creator: KeyCreator;
  recovered?: true;
}): Promise<MintRecord> {
  try {
    await mintedKey.complete({
      outcome: 'succeeded',
      details: {
        // The id the console shows, by its last characters only.
        keyIdSuffix: auditKeyIdSuffix('s3', minted.accessKeyId),
        ...(recovered ? { recovered } : {}),
      },
      // The cap ran against a role read before the vendor call, so the row
      // only lands if the role on file could still grant the key. The sequence
      // bump rides the same transaction, which is what lets a narrowing notice
      // a row that landed after its listing (`lib/access-key-mint-seq.ts`) —
      // and what keeps a refused mint from advancing it.
      items: [
        creatorRoleStillMintsCheck(creator),
        accessKeyMintSeqItem(creator),
        { Put: { TableName: Resource.UserInfoTable.name, Item: marshall(row) } },
      ],
    });
    return { recorded: true };
  } catch (err) {
    // The role check is item 0; `commitAudited` appends the audit Put last. The
    // unconditioned bump never cancels, but it holds a position, so it holds a
    // label.
    if (cancelledLabels(err, ['creatorRole', 'mintSeq', 'keyRow']).includes('creatorRole')) {
      return { recorded: false, reason: 'creator_role_changed' };
    }
    // A cancellation with no condition of ours in it is contention on the
    // sequence row: a second mint for this member, or the narrowing that asserts
    // it. Nothing landed, so the credential goes back rather than outliving the
    // request as an orphan nothing local records. Anything else is rethrown — a
    // timeout may have committed, and discarding a recorded key is worse.
    if (err instanceof TransactionCanceledException) {
      return { recorded: false, reason: 'write_conflict' };
    }
    throw err;
  }
}

/**
 * The vendor would not mint it, and each refusal means something different.
 *
 * A duplicate name is the one that may have created a credential anyway, on an
 * earlier attempt whose row never landed, so it goes through the recovery. A
 * validation error is the vendor rejecting the request, and closing the
 * correlation is what records that. Anything else leaves the intent dangling on
 * purpose: nobody knows whether a credential exists, which is what the operator
 * needs to see.
 */
async function handleMintRefusal(
  err: unknown,
  attempt: MintAttempt,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (err instanceof AccessKeyAlreadyExistsError) {
    await recoverDuplicateKey(attempt);
    return new ResponseBuilder()
      .status(409)
      .body<ErrorResponse>({ message: 'An access key with this name already exists' })
      .build();
  }
  if (err instanceof AccessKeyValidationError) {
    await attempt.mint.complete({ outcome: 'failed' });
    return new ResponseBuilder().status(400).body<ErrorResponse>({ message: err.message }).build();
  }
  throw err;
}

/**
 * The attributes a key row carries only when the form asked for them, so an
 * absent one reads as "not requested" rather than as an empty list.
 */
function optionalKeyAttributes({
  granularPermissions,
  buckets,
  expiresAt,
}: {
  granularPermissions: GranularPermission[] | undefined;
  buckets: string[] | undefined;
  expiresAt: string | null;
}): Pick<AccessKeyRecord, 'granularPermissions' | 'buckets' | 'expiresAt'> {
  return {
    ...(granularPermissions?.length ? { granularPermissions } : {}),
    ...(buckets ? { buckets } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

/**
 * The row did not land — the creator's role narrowed mid-mint, or the
 * transaction lost to contention on the sequence row.
 *
 * The credential exists at the vendor and nothing local records it, so it is
 * deleted here rather than left for the non-conforming-key review: the secret
 * has not been returned to anybody.
 *
 * The credential goes before the correlation closes. Closing first is
 * fail-closed and can throw, and a process that stops there leaves a live key
 * at the vendor with no local row and no record of it. A dangling intent is the
 * better failure: it is visible, and an orphan credential is not.
 *
 * When the delete fails too, the completion says so: `failed` alone would read
 * as a mint that came to nothing.
 */
async function discardUnrecordedKey({
  minted,
  mint,
  creator,
}: {
  minted: MintedKey;
  mint: AuditCorrelation<'key.created'>;
  creator: Pick<KeyCreator, 'orgId' | 'userId'>;
}): Promise<void> {
  let cleanupFailed = false;
  try {
    await minted.orchestrator.deleteAccessKey(minted.tenantId, minted.keyId);
  } catch (err) {
    cleanupFailed = true;
    console.error('[create-access-key] Could not discard a key whose row never landed', {
      orgId: creator.orgId,
      userId: creator.userId,
      keyIdSuffix: auditKeyIdSuffix('s3', minted.accessKeyId),
      error: err,
    });
  }
  await mint.complete({
    outcome: 'failed',
    ...(cleanupFailed ? { details: { cleanupFailed } } : {}),
  });
}

/**
 * The same narrowing, found one moment later.
 *
 * The row's own `ConditionCheck` refuses a key whose creator was demoted before
 * it landed. It cannot refuse one that landed first: at that instant the
 * creator did still hold a role that covers the key, so the condition is
 * satisfied and correctly so. The key only becomes excessive when the role
 * write follows, and by then the narrowing's listing has already been taken
 * without it.
 *
 * So the mint looks once more, being the only request holding the credential. A
 * demotion landing after this read is the narrowing's to catch
 * (`lib/access-key-mint-seq.ts`).
 *
 * The key, not the role: a promotion mid-mint strands nothing, a demotion that
 * still grants what the key holds is no reason to take it away, and an absent
 * membership grants nothing at all.
 */
async function keyExceedsCurrentRole({ orgId, userId, key }: KeyCreator): Promise<boolean> {
  const current = (await resolveMembership(orgId, userId))?.role ?? NO_ROLE;
  return !canRetainAccessKey(current, key).retained;
}

/**
 * Both halves this time: the row landed, unlike {@link discardUnrecordedKey}'s
 * path. Through `revokeAccessKey` so the removal is audited like any other,
 * and so the row delete rides its completion rather than being a second write
 * nobody records.
 */
async function discardRecordedKey({
  minted,
  creator,
  actor,
}: {
  minted: MintedKey;
  creator: Pick<KeyCreator, 'orgId' | 'userId'>;
  actor: AuditActor;
}): Promise<void> {
  try {
    await revokeAccessKey({ orgId: creator.orgId, ...minted, actor, reason: 'stale_role_at_mint' });
  } catch (err) {
    // Left for the operator rather than retried: a second delete against a
    // vendor that just refused one is not for a request path. A
    // `RevocationNotRecordedError` is a dead credential with a stale row;
    // anything else may still be live.
    console.error(
      err instanceof RevocationNotRecordedError
        ? '[create-access-key] Discarded a key whose creator was demoted, but its row survives'
        : '[create-access-key] Could not discard a key whose creator was demoted',
      {
        orgId: creator.orgId,
        userId: creator.userId,
        keyIdSuffix: auditKeyIdSuffix('s3', minted.accessKeyId),
        error: err,
      },
    );
  }
}

/**
 * The mint lost a race with another write to this member's keys. The credential
 * is gone, so the retry mints a fresh one rather than recovering this.
 */
function mintConflictResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({
      message: 'Another change to this member’s keys was in flight — try again.',
    })
    .build();
}

/** The answer when the creator's role moved: try again under the one they hold now. */
function creatorRoleChangedResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({
      message: 'Your role in this organization changed while the key was being created.',
      code: ApiErrorCode.FORBIDDEN_ROLE,
    })
    .build();
}

/**
 * The creator-authority cap: the requested key permissions are intersected with
 * the caller's own, so a key can never carry more than the member minting it.
 *
 * `keys.create` is the entry gate and runs in the chain. This is the half the
 * chain cannot express, because what it asks of the caller depends on the
 * checkboxes in the body. Without it the console matrix is decoration, because
 * a SigV4 key is redeemed over S3 where no role check runs until M3: a Member
 * denied `buckets.delete` in the console would simply mint a key and delete
 * buckets with it.
 *
 * The denial names the offending permissions, because "your role does not
 * permit this key" against a form with eight checkboxes is not actionable.
 */
function checkCreatorAuthority(
  event: AuthenticatedEvent,
  request: CreateAccessKeyRequest,
): APIGatewayProxyStructuredResultV2 | undefined {
  const excess = excessKeyPermissions(getUserInfo(event).membership?.role ?? '', request);
  if (excess.length === 0) return undefined;

  const named = excess.map(({ keyPermission }) => keyPermission).join(', ');
  return new ResponseBuilder()
    .status(403)
    .body<ErrorResponse>({
      message: `A key cannot carry more than you do. Your role does not permit: ${named}.`,
      code: ApiErrorCode.FORBIDDEN_ROLE,
    })
    .build();
}

/** What one attempt to mint had in hand when the vendor refused it. */
interface MintAttempt {
  orgId: string;
  tenantId: string;
  keyName: string;
  region: S3Region;
  orchestrator: ServiceOrchestrator;
  attribution: Pick<AccessKeyRecord, 'createdBy' | 'creatorEmail' | 'policyVersion'>;
  /** The intent this attempt already wrote — every exit here closes it. */
  mint: AuditCorrelation<'key.created'>;
  creator: KeyCreator;
}

async function recoverDuplicateKey({
  orgId,
  tenantId,
  keyName,
  region,
  orchestrator,
  attribution,
  mint,
  creator,
}: MintAttempt): Promise<void> {
  // Check if we already have a DynamoDB record for this key
  const { Items: existingKeys } = await getDynamoClient().send(
    new QueryCommand({
      TableName: Resource.UserInfoTable.name,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: AccessKeyKeys.orgPk(orgId) },
        ':skPrefix': { S: AccessKeyKeys.keySkPrefix() },
      },
    }),
  );

  const alreadyInDb = existingKeys?.some((item) => {
    const itemRegion = (item.region?.S as S3Region | undefined) ?? S3Region.EuWest1;
    return item.keyName?.S === keyName && itemRegion === region;
  });
  if (alreadyInDb) {
    // A plain duplicate name: the vendor refused and there is nothing to
    // recover, so the correlation closes as the rejection it was.
    await mint.complete({ outcome: 'failed' });
    return;
  }

  // Partial failure: key exists in Orchestrator's DB, but our DynamoDB record is missing.
  // Recover by fetching key details from the provider and writing the DB record.
  const recovered = await orchestrator.findAccessKeyByName(tenantId, keyName);

  if (!recovered) {
    // Shouldn't happen — orchestrator returned conflict but key not found in list.
    // Just return and let the user see the 409 message.
    console.error(
      `Orchestrator returned conflict for key "${keyName}" but key not found in list for tenant ${tenantId}`,
    );
    await mint.complete({ outcome: 'failed' });
    return;
  }

  const minted: MintedKey = {
    keyId: recovered.id,
    accessKeyId: recovered.accessKeyId,
    keyName,
    region,
    orchestrator,
    tenantId,
  };

  // The completion the earlier attempt never got to write. It closes this
  // request's intent, and `recovered` says the credential it names was minted
  // by a request whose own intent is still dangling.
  const record = await recordMintedKey({
    row: {
      pk: AccessKeyKeys.orgPk(orgId),
      sk: AccessKeyKeys.keySk(recovered.id),
      keyName,
      accessKeyId: recovered.accessKeyId,
      // The vendor's own timestamp, from the attempt that actually minted the
      // key — not this retry's clock, which would date the credential wrong.
      createdAt: recovered.createdAt,
      status: 'active',
      region,
      // Attributed to the caller who retried, which in practice is the same
      // person whose first attempt minted the key at the provider. A key with
      // no owner at all is the worse outcome, and `recovered` keeps the
      // record honest about which of the two this is.
      ...attribution,
      recovered: true,
    },
    minted,
    mintedKey: mint,
    creator,
    recovered: true,
  });
  // This path answers 409 either way; a row that did not land just leaves no
  // credential behind it.
  if (!record.recorded) {
    await discardUnrecordedKey({ minted, mint, creator });
    return;
  }

  console.warn(
    `Recovered DynamoDB record for access key "${keyName}" (id=${recovered.id}) for org ${orgId} using ${orchestrator.id} orchestrator`,
    { createdBy: attribution.createdBy, recovered: true },
  );
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  // The key's permissions are capped at the creator's own inside the handler;
  // that the creator is in the org at all is settled here, ahead of the billing
  // read a non-member should never cost.
  .use(requireOrgMembershipMiddleware())
  // Minting a key at all is `keys.create`, which does not depend on the body —
  // so it is declared in the manifest and checked here, like every other gated
  // route, rather than buried in the handler behind a JSON parse.
  .use(authorize('keys.create'))
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(errorHandlerMiddleware());
