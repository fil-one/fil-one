import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import {
  CreateAccessKeySchema,
  S3Region,
  excessKeyPermissions,
  isSupportedRegion,
} from '@filone/shared';
import type {
  CreateAccessKeyRequest,
  CreateAccessKeyResponse,
  ErrorResponse,
} from '@filone/shared';
import { AuditSubjects, twoPhaseAudit, userActor } from '../lib/audit.ts';
import {
  discardRecordedKey,
  discardUnrecordedKey,
  exceedsRoleResponse,
  keyExceedsCurrentRole,
  mintConflictResponse,
  optionalKeyAttributes,
  recordMintedKey,
  roleChangedResponse,
} from '../lib/key-mint.ts';
import type { KeyMinter, MintedKey } from '../lib/key-mint.ts';
import { listOrgAccessKeys } from '../lib/member-keys.ts';
import type { AuditCorrelation } from '../lib/audit.ts';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.ts';
import { AccessKeyAlreadyExistsError, AccessKeyValidationError } from '../lib/errors.ts';
import type { IssuedAccessKey, ServiceOrchestrator } from '../lib/service-orchestrator.ts';
import { cleanupDeadline, ORCHESTRATOR_SETUP_TIMEOUT_MS } from '../lib/service-orchestrator.ts';
import { isOrgDeleting } from '../lib/org-profile.ts';
import { parseJsonBody } from '../lib/parse-json-body.ts';
import {
  accountDeletedResponse,
  ResponseBuilder,
  tenantNotReadyResponse,
  unsupportedRegionResponse,
} from '../lib/response-builder.ts';
import { AccessKeyKeys, keyAttribution } from '../lib/dynamo-records.ts';
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
  // One deadline for the mint and everything it needs, tenant setup included.
  // This route has 30 s; a hung vendor fails the call and answers the user
  // instead of the Lambda timeout killing the handler. What runs after a mint
  // has already succeeded — the compensating delete, the duplicate recovery —
  // mints its own budget, because this one is usually spent by then.
  const signal = AbortSignal.timeout(ORCHESTRATOR_SETUP_TIMEOUT_MS);
  const tenantId = await orchestrator.ensureTenantReady(orgId, { signal });
  if (!tenantId) return tenantNotReadyResponse();

  // Before the intent, because nothing happened: a name the org already shows
  // is a request that was never going to produce a key, and writing an intent
  // for it would leave an operator reading a mint that never started.
  if (await orgAlreadyShowsKeyName({ orgId, keyName, region })) return duplicateKeyNameResponse();

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
    accessKey = await orchestrator.issueAccessKey(
      tenantId,
      { keyName, permissions, granularPermissions, buckets, expiresAt },
      { signal },
    );
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
      // Not the mint's signal: the refusal being handled is often the deadline
      // above expiring, and recovery would then have no budget to run in.
      cleanupSignal: cleanupDeadline(),
    });
  }

  const minted: MintedKey = {
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
      ...optionalKeyAttributes({ granularPermissions, bucketScope, buckets, expiresAt }),
      ...attribution,
    },
    mint,
    minter: creator,
  });
  // Both discards run after a successful mint, so the deadline above may be
  // spent; each gets its own.
  if (!record.recorded) {
    await discardUnrecordedKey({ minted, mint, minter: creator, signal: cleanupDeadline() });
    return record.reason === 'minter_role_changed' ? roleChangedResponse() : mintConflictResponse();
  }

  if (await keyExceedsCurrentRole(creator)) {
    await discardRecordedKey({ minted, minter: creator, actor, signal: cleanupDeadline() });
    return roleChangedResponse();
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

/**
 * Whether the org already lists a key under this name in this region.
 *
 * The vendor enforces name uniqueness per tenant, and until rotation shipped
 * that was enough: a duplicate came back as a 409 and nothing local had to ask.
 * A rotated key is minted under a suffixed vendor name, which frees the console
 * name at the vendor while the row goes on showing it, so the vendor would now
 * accept a second key the console would list twice under one name. This is the
 * check that keeps the name unique where it is actually read.
 *
 * Through `listOrgAccessKeys`, which follows `LastEvaluatedKey` to the end and
 * reads consistently on every page: a single Query answers one page, and a
 * rotation that just landed its replacement has freed the name at the vendor,
 * so a row this check does not see is a name a second key takes.
 *
 * Not a lock: two creates racing on the same free name can both pass it, and
 * the vendor only catches the pair whose name it still holds. A single-table
 * design has nowhere to put a uniqueness constraint, and a duplicate display
 * name is worth a narrow race rather than a second row to maintain.
 */
async function orgAlreadyShowsKeyName({
  orgId,
  keyName,
  region,
}: {
  orgId: string;
  keyName: string;
  region: S3Region;
}): Promise<boolean> {
  const keys = await listOrgAccessKeys(orgId);
  return keys.some((key) => key.keyName === keyName && key.region === region);
}

/** The name is taken, whoever is holding it. */
function duplicateKeyNameResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({ message: 'An access key with this name already exists' })
    .build();
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
    return duplicateKeyNameResponse();
  }
  if (err instanceof AccessKeyValidationError) {
    await attempt.mint.complete({ outcome: 'failed' });
    return new ResponseBuilder().status(400).body<ErrorResponse>({ message: err.message }).build();
  }
  throw err;
}

/**


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

  return exceedsRoleResponse(excess);
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
  creator: KeyMinter;
  /** A deadline of its own, because the mint's is usually what expired. */
  cleanupSignal: AbortSignal;
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
  cleanupSignal,
}: MintAttempt): Promise<void> {
  if (await orgAlreadyShowsKeyName({ orgId, keyName, region })) {
    // A plain duplicate name: the vendor refused and there is nothing to
    // recover, so the correlation closes as the rejection it was.
    await mint.complete({ outcome: 'failed' });
    return;
  }

  // Partial failure: key exists in Orchestrator's DB, but our DynamoDB record is missing.
  // Recover by fetching key details from the provider and writing the DB record.
  const recovered = await orchestrator.findAccessKeyByName(tenantId, keyName, {
    signal: cleanupSignal,
  });

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
    mint,
    minter: creator,
    recovered: true,
  });
  // This path answers 409 either way; a row that did not land just leaves no
  // credential behind it.
  if (!record.recorded) {
    await discardUnrecordedKey({ minted, mint, minter: creator, signal: cleanupSignal });
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
