import { QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import {
  ApiErrorCode,
  CreateAccessKeySchema,
  S3Region,
  auditKeyIdSuffix,
  excessKeyPermissions,
  isSupportedRegion,
} from '@filone/shared';
import type {
  CreateAccessKeyRequest,
  CreateAccessKeyResponse,
  ErrorResponse,
  GranularPermission,
  OrgRole,
} from '@filone/shared';
import { Resource } from 'sst';
import { AuditSubjects, twoPhaseAudit, userActor } from '../lib/audit.js';
import type { AuditCorrelation } from '../lib/audit.js';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.js';
import { AccessKeyAlreadyExistsError, AccessKeyValidationError } from '../lib/errors.js';
import type { IssuedAccessKey, ServiceOrchestrator } from '../lib/service-orchestrator.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { isOrgDeleting } from '../lib/org-profile.js';
import { parseJsonBody } from '../lib/parse-json-body.js';
import {
  accountDeletedResponse,
  ResponseBuilder,
  tenantNotReadyResponse,
  unsupportedRegionResponse,
} from '../lib/response-builder.js';
import { AccessKeyKeys, keyAttribution } from '../lib/dynamo-records.js';
import { cancelledLabels, memberRoleCheck } from '../lib/membership-changes.js';
import type { AccessKeyRecord } from '../lib/dynamo-records.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize, requireOrgMembershipMiddleware } from '../middleware/authorize.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

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

  const { orgId, userId, membership } = getUserInfo(event);
  // The role the cap above was evaluated against. The key row's write asserts
  // it is still the role on file.
  const creatorRole = membership!.role;
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
    if (err instanceof AccessKeyAlreadyExistsError) {
      await recoverDuplicateKey({
        orgId,
        tenantId,
        keyName,
        region,
        orchestrator,
        attribution,
        mint,
        creator: { orgId, userId, role: creatorRole },
      });
      return new ResponseBuilder()
        .status(409)
        .body<ErrorResponse>({ message: 'An access key with this name already exists' })
        .build();
    }
    if (err instanceof AccessKeyValidationError) {
      // The vendor refused the request. Closing the correlation is what says so:
      // an intent with no completion means the process died mid-flight.
      await mint.complete({ outcome: 'failed' });
      return new ResponseBuilder()
        .status(400)
        .body<ErrorResponse>({ message: err.message })
        .build();
    }
    // Left dangling on purpose: an unhandled vendor error is the case where
    // nobody knows whether a credential exists, and that is what the operator
    // needs to see.
    throw err;
  }

  const stale = await recordMintedKey({
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
      ...stampedScope({ granularPermissions, buckets, expiresAt }),
      ...attribution,
    },
    accessKeyId: accessKey.accessKeyId,
    keyId: accessKey.id,
    mint,
    creator: { orgId, userId, role: creatorRole },
    orchestrator,
    tenantId,
  });
  if (stale) return stale;

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
 * Write the key's row and the completion event as one transaction, so the
 * record of a live credential cannot be the half that fails.
 *
 * Both mint paths land here — the ordinary one and the duplicate recovery — so
 * a key row and its event are written the same way whichever attempt produced
 * the credential.
 */
async function recordMintedKey({
  row,
  accessKeyId,
  keyId,
  mint,
  creator,
  orchestrator,
  tenantId,
  recovered,
}: {
  row: Record<string, unknown>;
  accessKeyId: string;
  /** The orchestrator's id for the key, in case the write has to undo it. */
  keyId: string;
  mint: AuditCorrelation<'key.created'>;
  /** Whose role the cap was evaluated against, and the role it read. */
  creator: { orgId: string; userId: string; role: OrgRole };
  orchestrator: ServiceOrchestrator;
  tenantId: string;
  recovered?: true;
}): Promise<APIGatewayProxyStructuredResultV2 | undefined> {
  try {
    await mint.complete({
      outcome: 'succeeded',
      details: {
        // The id the console shows, by its last characters only.
        keyIdSuffix: auditKeyIdSuffix('s3', accessKeyId),
        ...(recovered ? { recovered } : {}),
      },
      // The cap ran against a role read before the vendor call. A narrowing
      // that commits in between revokes the keys it can see, and this row is
      // not one of them yet, so the row refuses to land at all.
      items: [
        memberRoleCheck(creator),
        { Put: { TableName: Resource.UserInfoTable.name, Item: marshall(row) } },
      ],
    });
    return undefined;
  } catch (err) {
    // The role check is item 0; `commitAudited` appends the audit Put last.
    if (!cancelledLabels(err, ['creatorRole', 'keyRow']).includes('creatorRole')) throw err;
    // The credential goes before the correlation closes. Closing first is
    // fail-closed and can throw, and a process that stops there leaves a live
    // key at the vendor with no local row and no record of it. A dangling
    // intent is the better failure: it is visible, and an orphan credential is
    // not.
    const discarded = await discardKeyMintedUnderAStaleRole({
      tenantId,
      keyId,
      orchestrator,
      context: { orgId: creator.orgId, userId: creator.userId },
    });
    await mint.complete({ outcome: 'failed' });
    return discarded;
  }
}

/**
 * The attributes a key row carries only when the form asked for them, so an
 * absent one reads as "not requested" rather than as an empty list.
 */
function stampedScope({
  granularPermissions,
  buckets,
  expiresAt,
}: {
  granularPermissions: GranularPermission[] | undefined;
  buckets: string[] | undefined;
  expiresAt: string | null;
}): Record<string, unknown> {
  return {
    ...(granularPermissions?.length ? { granularPermissions } : {}),
    ...(buckets ? { buckets } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

/**
 * The creator's role narrowed while the key was being minted.
 *
 * The credential exists at the vendor and nothing local records it, so it is
 * deleted here rather than left for the non-conforming-key review: the secret
 * has not been returned to anybody, and a 409 says to try again under the role
 * they now hold.
 */
async function discardKeyMintedUnderAStaleRole({
  tenantId,
  keyId,
  orchestrator,
  context,
}: {
  tenantId: string;
  keyId: string;
  orchestrator: ServiceOrchestrator;
  context: { orgId: string; userId: string };
}): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    await orchestrator.deleteAccessKey(tenantId, keyId);
  } catch (err) {
    console.error('[create-access-key] Could not discard a key minted under a stale role', {
      ...context,
      error: err,
    });
  }

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

interface RecoverDuplicateKeyParams {
  orgId: string;
  tenantId: string;
  keyName: string;
  region: S3Region;
  orchestrator: ServiceOrchestrator;
  attribution: Pick<AccessKeyRecord, 'createdBy' | 'creatorEmail' | 'policyVersion'>;
  /** The intent this attempt already wrote — every exit here closes it. */
  mint: AuditCorrelation<'key.created'>;
  /** Whose role the cap was evaluated against, and the role it read. */
  creator: { orgId: string; userId: string; role: OrgRole };
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
}: RecoverDuplicateKeyParams): Promise<void> {
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

  // The completion the earlier attempt never got to write. It closes this
  // request's intent, and `recovered` says the credential it names was minted
  // by a request whose own intent is still dangling.
  await recordMintedKey({
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
    accessKeyId: recovered.accessKeyId,
    keyId: recovered.id,
    mint,
    creator,
    orchestrator,
    tenantId,
    recovered: true,
  });
  // Its answer is dropped: this path is a 409 either way, and a role that went
  // stale leaves no row and no credential, which is the same outcome by a
  // different name.

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
