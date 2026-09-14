import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
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
  AccessKeyBucketScope,
  ErrorResponse,
  GranularPermission,
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
import type { KeyMinter, MintedKey } from '../lib/key-mint.ts';
import { revokeAndReport } from '../lib/key-revocation.ts';
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
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { authorize, requireOrgMembershipMiddleware } from '../middleware/authorize.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.ts';

const dynamo = getDynamoClient();

/** Names this handler in the shared mint helpers' log lines. */
const HANDLER = 'rotate-access-key';

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
 * bucket scope, buckets, expiry and region. What changes is the credential, and
 * `createdBy`, which names whoever asked for this one.
 *
 * The order of everything before the vendor call is `create-access-key.ts`'s,
 * for its reasons. What is new is that the key already exists, so the cap is
 * evaluated against what it carries rather than against a request body.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const prepared = await prepareRotation(event);
  return 'refused' in prepared ? prepared.refused : await issueReplacement(prepared);
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
): Promise<Rotation | { refused: APIGatewayProxyStructuredResultV2 }> {
  const keyId = event.pathParameters?.keyId;
  if (!keyId) {
    return refused(
      new ResponseBuilder()
        .status(400)
        .body<ErrorResponse>({ message: 'Missing keyId in path' })
        .build(),
    );
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
    return refused(
      new ResponseBuilder()
        .status(404)
        .body<ErrorResponse>({ message: 'Access key not found' })
        .build(),
    );
  }

  // Before the orchestrator is touched, as the revoke does it: minting a
  // replacement for somebody else's key is the half that cannot be undone.
  if (
    !withinScope(keyScope(event), { createdBy: Item.createdBy?.S, recovered: Item.recovered?.BOOL })
  ) {
    return refused(notYourKeyResponse());
  }

  const stored = readStoredKey(Item, keyId);

  // Read off the row before anything else asks about it: the permission set is
  // what the replacement is minted from, and a row that records none cannot
  // produce one. Nothing at the vendor can be read back to fill the gap.
  const { permissions } = stored;
  if (!permissions) return refused(unrecordedPermissionsResponse());

  // The same question a role narrowing asks of a key its holder already has,
  // and the same answer: a key is reissued when its holder could mint it today.
  const retention = canRetainAccessKey(membership?.role ?? NO_ROLE, {
    permissions,
    granularPermissions: stored.granularPermissions,
  });
  if (!retention.retained) return refused(refusedRotation(retention));

  if (hasExpired(stored.expiresAt)) {
    return refused(
      new ResponseBuilder()
        .status(400)
        .body<ErrorResponse>({
          message: `This key expired on ${stored.expiresAt}. Create a new key instead of rotating it.`,
        })
        .build(),
    );
  }

  if (!isSupportedRegion(stored.region, process.env.FILONE_STAGE!)) {
    return refused(unsupportedRegionResponse(stored.region));
  }

  // Before ensureTenantReady, as the mint has it: the replacement is minted
  // upstream, so a fence checked only at the DynamoDB write would leave a live
  // credential behind.
  if (await isOrgDeleting(orgId, { consistent: true })) return refused(accountDeletedResponse());

  const orchestrator = getOrchestratorForRegion(stored.region);
  const tenantId = await orchestrator.ensureTenantReady(orgId);
  if (!tenantId) return refused(tenantNotReadyResponse());

  return {
    keyId,
    stored,
    permissions,
    orchestrator,
    tenantId,
    rotator: { orgId, userId, email: getVerifiedEmail(event) },
  };
}

/** Mint the replacement, record it, and take the key it supersedes. */
async function issueReplacement({
  keyId,
  stored,
  permissions,
  orchestrator,
  tenantId,
  rotator,
}: Rotation): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId, userId, email } = rotator;
  const actor = userActor({ userId, email });
  const minter: KeyMinter = {
    orgId,
    userId,
    key: { permissions, granularPermissions: stored.granularPermissions },
  };

  // Fail-closed and ahead of the vendor, for the mint's reason: no SigV4 key may
  // come into existence without a record that somebody asked for it. The intent
  // names the key being replaced, which is what joins this event to the
  // `key.deleted` the revoke writes — without it the pair reads as an unrelated
  // create and revoke moments apart.
  const mint = await twoPhaseAudit({
    type: 'key.created',
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
    replacement = await orchestrator.issueAccessKey(tenantId, {
      keyName: vendorKeyName,
      permissions,
      granularPermissions: stored.granularPermissions,
      buckets: stored.bucketScope === 'specific' ? (stored.buckets ?? []) : undefined,
      expiresAt: stored.expiresAt ?? null,
    });
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

  const row: AccessKeyRecord = {
    pk: AccessKeyKeys.orgPk(orgId),
    sk: AccessKeyKeys.keySk(replacement.id),
    keyName: stored.keyName,
    accessKeyId: replacement.accessKeyId,
    createdAt: replacement.createdAt,
    status: 'active',
    region: stored.region,
    permissions,
    vendorKeyName,
    ...optionalKeyAttributes(stored),
    ...carriedAttribution(stored),
  };

  const record = await recordMintedKey({ row, mint, minter });
  if (!record.recorded) {
    await discardUnrecordedKey({ minted, mint, minter, handler: HANDLER });
    return record.reason === 'minter_role_changed'
      ? roleChangedResponse('rotated')
      : mintConflictResponse();
  }

  // The row's own condition cannot refuse a demotion that landed just after the
  // write, so the rotation looks once more while it is the only request holding
  // the credential. `create-access-key.ts` explains the race in full.
  if (await keyExceedsCurrentRole(minter)) {
    await discardRecordedKey({ minted, minter, actor, handler: HANDLER });
    return roleChangedResponse('rotated');
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
  stored: StoredKey;
  /** The row's permission set, having been found present. */
  permissions: AccessKeyPermission[];
  orchestrator: ServiceOrchestrator;
  tenantId: string;
  /** Who asked. Everything the mint needs about them is derived from this. */
  rotator: { orgId: string; userId: string; email?: string };
}

/** A response the request stops at, tagged so the caller can tell it from a context. */
function refused(response: APIGatewayProxyStructuredResultV2): {
  refused: APIGatewayProxyStructuredResultV2;
} {
  return { refused: response };
}

/** What the stored row says the replacement has to carry. */
interface StoredKey {
  keyName: string;
  /** Absent on a row written before the id was stored. */
  accessKeyId?: string;
  /** The name the vendor holds this key under, when a rotation gave it one. */
  vendorKeyName?: string;
  /** The key's owner, carried onto the replacement. Absent on a row older than roles. */
  createdBy?: string;
  creatorEmail?: string;
  /** The original's attribution was a guess, so the replacement's is too. */
  recovered?: boolean;
  region: S3Region;
  permissions?: AccessKeyPermission[];
  granularPermissions?: GranularPermission[];
  bucketScope?: AccessKeyBucketScope;
  buckets?: string[];
  expiresAt?: string;
}

/**
 * The row, read as the thing the replacement is minted from.
 *
 * A row with no `region` predates multi-region routing, so it takes
 * {@link DEFAULT_ACCESS_KEY_REGION}, the same fallback the revoke applies. `permissions` is deliberately left
 * possibly-absent rather than defaulted: an empty set would mint a key that can
 * do nothing, and the caller refuses the row instead.
 *
 * The attribution fields come along because the replacement keeps them: see
 * {@link carriedAttribution}.
 */
function readStoredKey(item: Record<string, AttributeValue>, keyId: string): StoredKey {
  const row = unmarshall(item) as Partial<AccessKeyRecord>;

  return {
    ...(row.accessKeyId ? { accessKeyId: row.accessKeyId } : {}),
    ...(row.vendorKeyName ? { vendorKeyName: row.vendorKeyName } : {}),
    ...(row.createdBy ? { createdBy: row.createdBy } : {}),
    ...(row.creatorEmail ? { creatorEmail: row.creatorEmail } : {}),
    ...(row.recovered ? { recovered: row.recovered } : {}),
    ...(row.permissions?.length ? { permissions: row.permissions } : {}),
    ...(row.granularPermissions ? { granularPermissions: row.granularPermissions } : {}),
    ...(row.bucketScope ? { bucketScope: row.bucketScope } : {}),
    ...(row.buckets ? { buckets: row.buckets } : {}),
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
    keyName: row.keyName ?? keyId,
    region: row.region ?? DEFAULT_ACCESS_KEY_REGION,
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
  mint: AuditCorrelation<'key.created'>,
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
