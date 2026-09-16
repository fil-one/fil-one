import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue, TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import {
  ApiErrorCode,
  NO_ROLE,
  S3Region,
  auditKeyIdSuffix,
  canRetainAccessKey,
  isSupportedRegion,
} from '@filone/shared';
import type {
  AccessKeyPermission,
  ErrorResponse,
  KeyRetentionResult,
  RotateAccessKeyResponse,
} from '@filone/shared';
import { Resource } from 'sst';
import { AuditSubjects, twoPhaseAudit, userActor } from '../lib/audit.ts';
import type { AuditCorrelation } from '../lib/audit.ts';
import { getDynamoClient } from '../lib/ddb-client.ts';
import { AccessKeyKeys, DEFAULT_ACCESS_KEY_REGION, keyAttribution } from '../lib/dynamo-records.ts';
import type { AccessKeyRecord } from '../lib/dynamo-records.ts';
import { AccessKeyAlreadyExistsError, AccessKeyValidationError } from '../lib/errors.ts';
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
import type { KeyMinter, MintRecord, MintedKey } from '../lib/key-mint.ts';
import { revokeAndReport } from '../lib/key-revocation.ts';
import { rotatorStillAuthorizedCheck } from '../lib/membership-changes.ts';
import { keyScope, notYourKeyResponse, withinScope } from '../lib/key-scope.ts';
import { isOrgDeleting } from '../lib/org-profile.ts';
import {
  accountDeletedResponse,
  ResponseBuilder,
  tenantNotReadyResponse,
  unsupportedRegionResponse,
} from '../lib/response-builder.ts';
import { vendorNameForRotation } from '../lib/rotation-key-name.ts';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.ts';
import type { IssuedAccessKey, ServiceOrchestrator } from '../lib/service-orchestrator.ts';
import { ORCHESTRATOR_SETUP_TIMEOUT_MS } from '../lib/service-orchestrator.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { authorize, requireOrgMembershipMiddleware } from '../middleware/authorize.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.ts';

const dynamo = getDynamoClient();

/**
 * Replace a key's credential and keep everything else about it.
 *
 * The mint comes first and the revoke second, which is the whole shape of this
 * handler. A key name is unique per tenant and no orchestrator can rename one,
 * so the replacement is minted under a suffixed name and the row goes on
 * showing the name its owner chose (`lib/rotation-key-name.ts`). Ordering it the
 * other way — revoke, then mint under the freed name — would leave a caller
 * whose mint then failed with no credential at all.
 *
 * What carries over is everything the row records: permissions, granulars,
 * bucket scope, buckets, expiry, region and owner. What changes is the
 * credential.
 *
 * The order of everything before the vendor call is `create-access-key.ts`'s,
 * for its reasons. What is new is that the key already exists, so the cap is
 * evaluated against what it carries rather than against a request body.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const prepared = await prepareRotation(event);
  return 'keyId' in prepared ? await issueReplacement(prepared) : prepared;
}

/**
 * Everything that can refuse a rotation before the vendor is touched, and the
 * context the mint needs once nothing has.
 *
 * Separate from the mint because the two answer different questions: this one
 * is about whether the request may proceed, and nothing it does is visible
 * afterwards. The order inside it is load-bearing, and each step says why.
 */
async function prepareRotation(
  event: AuthenticatedEvent,
): Promise<Rotation | APIGatewayProxyStructuredResultV2> {
  const keyId = event.pathParameters?.keyId;
  if (!keyId) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Missing keyId in path' })
      .build();
  }

  const { orgId, userId, membership } = getUserInfo(event);

  // Consistently, like the listing a role narrowing reads: an eventually
  // consistent read of a key somebody just revoked would mint a replacement for
  // a credential that no longer exists, and answer 201 for it.
  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: marshall({ pk: AccessKeyKeys.orgPk(orgId), sk: AccessKeyKeys.keySk(keyId) }),
      ConsistentRead: true,
    }),
  );
  if (!Item) {
    return new ResponseBuilder()
      .status(404)
      .body<ErrorResponse>({ message: 'Access key not found' })
      .build();
  }

  // Before the orchestrator is touched, as the revoke does it: minting a
  // replacement for somebody else's key is the half that cannot be undone.
  if (
    !withinScope(keyScope(event), { createdBy: Item.createdBy?.S, recovered: Item.recovered?.BOOL })
  ) {
    return notYourKeyResponse();
  }

  const stored = readStoredKey(Item, keyId);

  // Read off the row before anything else asks about it: the permission set is
  // what the replacement is minted from, and a row that records none cannot
  // produce one. Nothing at the vendor can be read back to fill the gap.
  const { permissions } = stored;
  if (!permissions?.length) return unrecordedPermissionsResponse();

  // A row already naming its replacement had a rotation land whose revoke did
  // not. The replacement is the key to use; this one is only left to delete.
  if (stored.replacedBy) return alreadyReplacedResponse();

  // The same question a role narrowing asks of a key its holder already has,
  // and the same answer: a key is reissued when its holder could mint it today.
  const retention = canRetainAccessKey(membership?.role ?? NO_ROLE, {
    permissions,
    granularPermissions: stored.granularPermissions,
  });
  if (!retention.retained) return refusedRotation(retention);

  if (hasExpired(stored.expiresAt)) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({
        message: `This key expired on ${stored.expiresAt}. Create a new key instead of rotating it.`,
      })
      .build();
  }

  if (!isSupportedRegion(stored.region, process.env.FILONE_STAGE!)) {
    return unsupportedRegionResponse(stored.region);
  }

  // Before ensureTenantReady, as the mint has it: the replacement is minted
  // upstream, so a fence checked only at the DynamoDB write would leave a live
  // credential behind.
  if (await isOrgDeleting(orgId, { consistent: true })) return accountDeletedResponse();

  const orchestrator = getOrchestratorForRegion(stored.region);
  // One deadline for every upstream call the rotation makes: tenant setup,
  // the mint, and the revocation of the key it replaces. This route has 60 s;
  // a hung vendor fails the call and answers the user instead of the Lambda
  // timeout killing the handler.
  const signal = AbortSignal.timeout(ORCHESTRATOR_SETUP_TIMEOUT_MS);
  const tenantId = await orchestrator.ensureTenantReady(orgId, { signal });
  if (!tenantId) return tenantNotReadyResponse();

  return {
    keyId,
    stored: { ...stored, permissions },
    orchestrator,
    tenantId,
    signal,
    rotator: { orgId, userId, email: getVerifiedEmail(event) },
  };
}

/** Mint the replacement, record it, and take the key it supersedes. */
async function issueReplacement({
  keyId,
  stored,
  orchestrator,
  tenantId,
  rotator,
  signal,
}: Rotation): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId, userId, email } = rotator;
  const actor = userActor({ userId, email });
  // The replacement is the owner's key, so the owner is whose role the row
  // write asserts and whose mint sequence it bumps: a narrowing of the owner's
  // role that listed their keys a moment ago has to notice this row, and it
  // fences on the owner's sequence, not the rotator's. The rotator's own
  // authority was checked against the row before the vendor was called; they
  // grant nothing here that the owner did not already hold. A row naming no
  // owner falls back to the rotator, who is the only member it can be about.
  const owner = stored.createdBy ?? userId;
  const minter: KeyMinter = { orgId, userId: owner, key: stored };
  const ownedByCaller = owner === userId;

  // Fail-closed and ahead of the vendor, for the mint's reason: no SigV4 key may
  // come into existence without a record that somebody asked for it. Its own
  // event type, so the log says a key was rotated rather than leaving the reader
  // to pair a create with a revoke a second apart; the intent names the key
  // being replaced, and the `key.deleted` the revoke writes carries `rotation`
  // as its reason, so the two point at each other.
  const mint = await twoPhaseAudit({
    type: 'key.rotated',
    mode: 'fail-closed',
    actor,
    orgId,
    subject: AuditSubjects.org(orgId),
    details: {
      keyKind: 's3',
      keyName: stored.keyName,
      region: stored.region,
      replacedKeyIdSuffix: auditKeyIdSuffix('s3', stored.accessKeyId ?? keyId),
    },
  });

  const vendorKeyName = vendorNameForRotation(stored.keyName);

  let replacement: IssuedAccessKey;
  try {
    replacement = await orchestrator.issueAccessKey(
      tenantId,
      {
        keyName: vendorKeyName,
        permissions: stored.permissions,
        granularPermissions: stored.granularPermissions,
        buckets: stored.bucketScope === 'specific' ? (stored.buckets ?? []) : undefined,
        expiresAt: stored.expiresAt ?? null,
      },
      { signal },
    );
  } catch (err) {
    return await handleMintRefusal(err, mint);
  }

  const minted: MintedKey = {
    keyId: replacement.id,
    accessKeyId: replacement.accessKeyId,
    keyName: stored.keyName,
    region: stored.region,
    orchestrator,
    tenantId,
  };

  const row = replacementRow({ orgId, stored, replacement, vendorKeyName, rotatedBy: userId });

  // Claiming the source row in the same transaction is what serialises two
  // rotations of one key: the second finds `replacedBy` set and its row does
  // not land, so it hands its credential back. `attribute_exists` covers a key
  // revoked between the read at the top and this write.
  // A key that is not the caller's also asserts the caller's own authority,
  // which the row write otherwise says nothing about: the owner's row is the
  // one the mint conditions, and a caller demoted or removed mid-flight would
  // complete on the snapshot they arrived with.
  const record = await recordMintedKey({
    row,
    mint,
    minter,
    alongside: [
      claimSourceRow({ orgId, keyId, replacedBy: replacement.id }),
      ...(ownedByCaller
        ? []
        : [
            {
              item: rotatorStillAuthorizedCheck({ orgId, userId, key: stored }),
              label: 'rotatorRole',
            },
          ]),
    ],
  });
  if (!record.recorded) {
    await discardUnrecordedKey({ minted, mint, minter, signal });
    return unrecordedResponse(record, ownedByCaller);
  }

  // The row's own condition cannot refuse a demotion that landed just after the
  // write, so the rotation looks once more while it is the only request holding
  // the credential. `create-access-key.ts` explains the race in full.
  if (await keyExceedsCurrentRole(minter)) {
    // The claim on the old row named a replacement that is now gone. Left in
    // place it would strand the key: live, listed, and refused every rotation
    // as already rotated. Released only once the credential is gone, so a
    // claim never points at nothing while a credential still exists.
    if (await discardRecordedKey({ minted, minter, actor, signal })) {
      await releaseSourceClaim({ orgId, keyId, replacedBy: replacement.id });
    }
    return ownerRoleChangedResponse(ownedByCaller);
  }

  // The old row is deleted here, inside the revocation's own audit completion,
  // rather than in the transaction above. Deleting it there would leave a live
  // credential at the vendor with no local row whenever this call then failed,
  // which is the one outcome nobody can see. This way the worst case is two
  // listed keys, and the caller is told about it.
  const previousKeyRevoked = await revokeAndReport({
    orgId,
    keyId,
    accessKeyId: stored.accessKeyId,
    // The name the vendor holds it under, which is what an operator reading the
    // event would search for. The two differ once a key has been rotated before.
    keyName: stored.vendorKeyName ?? stored.keyName,
    region: stored.region,
    orchestrator,
    tenantId,
    actor,
    reason: 'rotation',
    signal,
  });

  return new ResponseBuilder()
    .status(201)
    .body<RotateAccessKeyResponse>({
      id: replacement.id,
      keyName: stored.keyName,
      accessKeyId: replacement.accessKeyId,
      secretAccessKey: replacement.accessKeySecret,
      createdAt: replacement.createdAt,
      previousKeyRevoked,
    })
    .build();
}

/** A rotation that nothing refused, and everything the mint reads. */
interface Rotation {
  /** The orchestrator's id for the key being replaced. */
  keyId: string;
  /** The row, its permission set having been found present. */
  stored: StoredKey & { permissions: AccessKeyPermission[] };
  orchestrator: ServiceOrchestrator;
  tenantId: string;
  /** Who asked. Everything the mint needs about them is derived from this. */
  rotator: { orgId: string; userId: string; email?: string };
  /** One deadline for every vendor call the rotation makes. */
  signal: AbortSignal;
}

/**
 * The stored row, with the two fallbacks a legacy row needs: a row written
 * before the id was stored has no `keyName` to show, and one written before
 * multi-region routing has no `region`, so it takes
 * {@link DEFAULT_ACCESS_KEY_REGION}, the same fallback the revoke applies.
 * Everything else is read as stored; `unmarshall` leaves an absent attribute
 * absent, which is what the row write needs.
 */
type StoredKey = Partial<AccessKeyRecord> & { keyName: string; region: S3Region };

function readStoredKey(item: Record<string, AttributeValue>, keyId: string): StoredKey {
  const row = unmarshall(item) as Partial<AccessKeyRecord>;
  return { ...row, keyName: row.keyName ?? keyId, region: row.region ?? DEFAULT_ACCESS_KEY_REGION };
}

/** The replacement's row: the original's shape, a new credential, and who reissued it. */
function replacementRow({
  orgId,
  stored,
  replacement,
  vendorKeyName,
  rotatedBy,
}: {
  orgId: string;
  stored: Rotation['stored'];
  replacement: IssuedAccessKey;
  vendorKeyName: string;
  rotatedBy: string;
}): AccessKeyRecord {
  return {
    pk: AccessKeyKeys.orgPk(orgId),
    sk: AccessKeyKeys.keySk(replacement.id),
    keyName: stored.keyName,
    accessKeyId: replacement.accessKeyId,
    createdAt: replacement.createdAt,
    status: 'active',
    region: stored.region,
    permissions: stored.permissions,
    vendorKeyName,
    // Who reissued it and when, beside the owner the row keeps.
    rotatedBy,
    rotatedAt: replacement.createdAt,
    ...optionalKeyAttributes(stored),
    ...carriedAttribution(stored),
  };
}

/**
 * Who the replacement belongs to, which is whoever the original belonged to.
 *
 * An Admin rotating a member's key is doing maintenance on it, not taking it.
 * Moving `createdBy` to the rotator would drop the key out of its holder's list
 * and take away their right to revoke it — `keys.manage_own` is what scopes
 * both — and the first they would know of it is a client that stopped working.
 * The audit events name who actually rotated it, which is where that belongs.
 *
 * A row that named nobody goes on naming nobody: an unattributed key is visible
 * only under `keys.manage_all`, and inventing an owner for it here would hand
 * it to whoever happened to rotate it. `recovered` carries over for the same
 * reason — if the original's attribution was a guess, so is the replacement's.
 */
function carriedAttribution(
  stored: StoredKey,
): Pick<AccessKeyRecord, 'createdBy' | 'creatorEmail' | 'policyVersion' | 'recovered'> {
  if (!stored.createdBy) return {};
  return {
    ...keyAttribution({ userId: stored.createdBy, creatorEmail: stored.creatorEmail }),
    ...(stored.recovered ? { recovered: stored.recovered } : {}),
  };
}

/** Whether the key's own expiry date has already passed, in UTC days. */
function hasExpired(expiresAt: string | undefined): boolean {
  if (!expiresAt) return false;
  return expiresAt < new Date().toISOString().slice(0, 10);
}

/**
 * The row says nothing about what its key carries, so no replacement can be
 * built from it. Every such row predates attribution or was rebuilt after a
 * vendor conflict, and `keys.manage_all` is the only scope that sees one.
 */
function unrecordedPermissionsResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({
      message:
        'What this key carries was never recorded, so it cannot be reissued. Create a replacement and delete this one.',
    })
    .build();
}

/**
 * The row the replacement supersedes, claimed for exactly one replacement.
 *
 * One item doing two jobs, because a transaction may touch an item once: the
 * condition refuses a row already claimed or already gone, and the update
 * records which key took it. Nothing reads `replacedBy` on a request path
 * except the next rotation of this row, which it refuses.
 */
function claimSourceRow({
  orgId,
  keyId,
  replacedBy,
}: {
  orgId: string;
  keyId: string;
  replacedBy: string;
}): { item: TransactWriteItem; label: string } {
  return {
    label: 'sourceRow',
    item: {
      Update: {
        TableName: Resource.UserInfoTable.name,
        Key: marshall({ pk: AccessKeyKeys.orgPk(orgId), sk: AccessKeyKeys.keySk(keyId) }),
        UpdateExpression: 'SET replacedBy = :replacedBy',
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(replacedBy)',
        ExpressionAttributeValues: marshall({ ':replacedBy': replacedBy }),
      },
    },
  };
}

/** What the caller hears when the replacement's row did not land, by why. */
function unrecordedResponse(
  record: Exclude<MintRecord, { recorded: true }>,
  ownedByCaller: boolean,
): APIGatewayProxyStructuredResultV2 {
  switch (record.reason) {
    case 'minter_role_changed':
      return ownerRoleChangedResponse(ownedByCaller);
    case 'condition_failed':
      // The rotator's own row refused, or the source row was already claimed.
      return record.label === 'rotatorRole' ? roleChangedResponse() : sourceClaimedResponse();
    case 'write_conflict':
      return mintConflictResponse();
  }
}

/**
 * Take back the claim {@link claimSourceRow} put on the old row, when the
 * replacement it named is gone. Conditional on the claim still being ours: a
 * later rotation may have landed its own by now, and that one stands.
 */
async function releaseSourceClaim({
  orgId,
  keyId,
  replacedBy,
}: {
  orgId: string;
  keyId: string;
  replacedBy: string;
}): Promise<void> {
  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: marshall({ pk: AccessKeyKeys.orgPk(orgId), sk: AccessKeyKeys.keySk(keyId) }),
        UpdateExpression: 'REMOVE replacedBy',
        ConditionExpression: 'replacedBy = :ours',
        ExpressionAttributeValues: marshall({ ':ours': replacedBy }),
      }),
    );
  } catch (err) {
    // The key is live and listed either way; what is lost is its next rotation,
    // which the operator can restore by clearing the attribute.
    console.error(
      '[rotate-access-key] Could not release the claim on a key whose replacement was discarded',
      {
        orgId,
        error: err,
      },
    );
  }
}

/** Another request rotated or revoked this key first; the caller's list is stale. */
function sourceClaimedResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({
      message: 'This key was rotated or deleted by another request. Refresh the list.',
    })
    .build();
}

/** The row already names its replacement, so there is nothing left to rotate. */
function alreadyReplacedResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({
      message: 'This key has already been rotated. Use its replacement and delete this one.',
    })
    .build();
}

/**
 * The role that has to hold the replacement moved mid-rotation. When that is
 * the caller's own, the shared answer fits; when it is the owner's, telling the
 * caller their role changed would be false, and what they can act on is the
 * revoke.
 */
function ownerRoleChangedResponse(ownedByCaller: boolean): APIGatewayProxyStructuredResultV2 {
  if (ownedByCaller) return roleChangedResponse();
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({
      message: "This key's owner can no longer hold it after a role change. Revoke it instead.",
      code: ApiErrorCode.FORBIDDEN_ROLE,
    })
    .build();
}

/**
 * Why the rotator's role cannot reissue this key, said in terms they can act
 * on: "your role does not permit this key" against eight checkboxes is not
 * actionable, so the excess is named.
 */
function refusedRotation(
  retention: Extract<KeyRetentionResult, { retained: false }>,
): APIGatewayProxyStructuredResultV2 {
  switch (retention.reason) {
    case 'permissions_unrecorded':
      return unrecordedPermissionsResponse();
    case 'role_cannot_mint':
      return new ResponseBuilder()
        .status(403)
        .body<ErrorResponse>({
          message: 'Your role in this organization does not permit creating keys.',
          code: ApiErrorCode.FORBIDDEN_ROLE,
        })
        .build();
    case 'exceeds_role':
      return exceedsRoleResponse(retention.excess);
  }
}

/**
 * The vendor would not mint the replacement.
 *
 * A name conflict here is not the mint's recoverable case: the name was
 * generated fresh for this attempt, so a conflict means the vendor is holding
 * something under a name nothing asked for, and there is no local row to
 * rebuild. Both refusals close the correlation, and the caller keeps the key
 * they already had.
 */
async function handleMintRefusal(
  err: unknown,
  mint: AuditCorrelation<'key.rotated'>,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (err instanceof AccessKeyAlreadyExistsError) {
    await mint.complete({ outcome: 'failed' });
    return new ResponseBuilder()
      .status(409)
      .body<ErrorResponse>({ message: 'The replacement key could not be named — try again.' })
      .build();
  }
  if (err instanceof AccessKeyValidationError) {
    await mint.complete({ outcome: 'failed' });
    return new ResponseBuilder().status(400).body<ErrorResponse>({ message: err.message }).build();
  }
  throw err;
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(requireOrgMembershipMiddleware())
  // Rotating mints, so the gate is the mint's. What the replacement may carry
  // is capped in the handler against the stored row, which the chain cannot see.
  .use(authorize('keys.create'))
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(errorHandlerMiddleware());
