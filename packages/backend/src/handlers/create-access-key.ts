import { QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { CreateAccessKeySchema, S3Region, isSupportedRegion } from '@filone/shared';
import type { CreateAccessKeyResponse, ErrorResponse } from '@filone/shared';
import { Resource } from 'sst';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.js';
import { AccessKeyAlreadyExistsError, AccessKeyValidationError } from '../lib/errors.js';
import type { IssuedAccessKey, ServiceOrchestrator } from '../lib/service-orchestrator.js';
import { accountDeletedResponse } from '../lib/account-deleted-response.js';
import {
  getOrgProfile,
  isOrgDeleting,
  OrgDeletingError,
  sendGuardedWrite,
} from '../lib/org-profile.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import {
  ResponseBuilder,
  tenantNotReadyResponse,
  unsupportedRegionResponse,
} from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

// TODO: Refactor the handler, reducing its complexity and removing the ignore eslint directive.
// https://linear.app/filecoin-foundation/issue/FIL-320/refactor-create-access-key-handler
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Invalid JSON body' })
      .build();
  }

  const parsed = CreateAccessKeySchema.safeParse(body);
  if (!parsed.success) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: parsed.error.issues[0].message })
      .build();
  }

  const { keyName, permissions, granularPermissions, bucketScope, region } = parsed.data;
  const buckets = bucketScope === 'specific' ? (parsed.data.buckets ?? []) : undefined;
  const expiresAt = parsed.data.expiresAt ?? null;

  const { orgId } = getUserInfo(event);

  if (!isSupportedRegion(region, process.env.FILONE_STAGE!)) {
    return unsupportedRegionResponse(region);
  }

  // FIL-112: the org-profile `deleting` guard, PRE-checked — the one place in this sweep where a
  // conditional write alone is not enough. `issueAccessKey` below mints a live
  // S3 credential upstream BEFORE anything is written to DynamoDB, so a write
  // the fence rejects would leave that credential alive with no `ACCESSKEY#`
  // row for the teardown to find. Checking first means the common case never
  // mints at all. The write is still fenced (below) for the true race, and that
  // path compensates by revoking what it just minted.
  //
  // This is a check, not the fence, and it is deliberately the WEAKER of the
  // two: it reads a missing profile as healthy. That is survivable — a purged
  // org has no tenant either, so `ensureTenantReady` below cannot return one
  // (tenant setup's `attribute_exists(pk)` condition refuses to RECORD one on a
  // purged profile), and the fenced write would refuse regardless. Note what
  // that leaves behind: a tenant-setup racing the teardown can orphan an upstream
  // tenant — see the conditional `attribute_not_exists(deleting)` write in
  // `lib/orchestrator/tenant-setup.ts` `processTenantSetup`, which creates the
  // upstream tenant before it can fail to record one. The pre-check does not
  // close that. What matters here is that the two
  // agree on `deleting: false`: if the fence rejected what this accepts, we
  // would mint upstream and then compensate by revoking a healthy org's key.
  const orgProfile = await getOrgProfile(orgId, { consistent: true });
  if (isOrgDeleting(orgProfile)) {
    console.warn('[create-access-key] Refusing to mint a key: org deletion in progress', { orgId });
    return accountDeletedResponse();
  }

  const orchestrator = getOrchestratorForRegion(region);
  const tenantId = await orchestrator.ensureTenantReady(orgId);
  if (!tenantId) return tenantNotReadyResponse();

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
      await recoverDuplicateKey({ orgId, tenantId, keyName, region, orchestrator });
      return new ResponseBuilder()
        .status(409)
        .body<ErrorResponse>({ message: 'An access key with this name already exists' })
        .build();
    }
    if (err instanceof AccessKeyValidationError) {
      return new ResponseBuilder()
        .status(400)
        .body<ErrorResponse>({ message: err.message })
        .build();
    }
    throw err;
  }

  const recorded = await recordIssuedAccessKey({
    orgId,
    tenantId,
    orchestrator,
    accessKey,
    request: { keyName, permissions, granularPermissions, bucketScope, buckets, expiresAt, region },
  });
  if (!recorded) return accountDeletedResponse();

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

/** The validated request fields persisted alongside the issued key. */
interface RecordedAccessKeyRequest {
  keyName: string;
  permissions: string[];
  granularPermissions: string[] | undefined;
  bucketScope: string;
  buckets: string[] | undefined;
  expiresAt: string | null;
  region: S3Region;
}

/**
 * Persist the `ACCESSKEY#` row behind the org-profile `deleting` guard (FIL-112), compensating the
 * credential `issueAccessKey` just minted when the fence rejects.
 *
 * @returns `false` when the fence refused the write — the caller answers 410.
 */
async function recordIssuedAccessKey(args: {
  orgId: string;
  tenantId: string;
  orchestrator: ServiceOrchestrator;
  accessKey: IssuedAccessKey;
  request: RecordedAccessKeyRequest;
}): Promise<boolean> {
  const { orgId, tenantId, orchestrator, accessKey, request } = args;
  const { keyName, permissions, granularPermissions, bucketScope, buckets, expiresAt, region } =
    request;
  try {
    await sendGuardedWrite(orgId, [
      {
        Put: {
          TableName: Resource.UserInfoTable.name,
          Item: marshall({
            pk: `ORG#${orgId}`,
            sk: `ACCESSKEY#${accessKey.id}`,
            keyName,
            accessKeyId: accessKey.accessKeyId,
            createdAt: accessKey.createdAt,
            status: 'active',
            region,
            permissions,
            ...(granularPermissions?.length ? { granularPermissions } : {}),
            bucketScope,
            ...(buckets ? { buckets } : {}),
            ...(expiresAt ? { expiresAt } : {}),
          }),
        },
      },
    ]);
    return true;
  } catch (err) {
    if (!(err instanceof OrgDeletingError)) throw err;
    await cleanOrphanedKeys({ orgId, tenantId, keyId: accessKey.id, orchestrator });
    return false;
  }
}

interface CompensateOrphanedKeyParams {
  orgId: string;
  tenantId: string;
  /** Orchestrator id of the key issued by THIS request — never any other key. */
  keyId: string;
  orchestrator: ServiceOrchestrator;
}

/**
 * Revoke the credential this request just minted, after the org-profile `deleting` guard refused to
 * record it (mirrors the compensation in lib/create-billing-trial.ts and
 * handlers/create-setup-intent.ts).
 *
 * This is a destructive call on an already-failed path, so its blast radius is
 * pinned to one key: `keyId` is the id `issueAccessKey` returned moments ago on
 * this very request, never a listed or looked-up key, and this function is
 * reached only from the fence-rejection branch. The duplicate-key path returns
 * 409 before it, so a key that already existed can never arrive here.
 *
 * Failure is logged, not thrown: the caller's answer to the client is 410
 * either way, and masking that with a 500 would only invite a retry that mints
 * a second key. What a failed revoke leaves behind depends on the orchestrator
 * and is worth stating exactly: teardown does NOT revoke any key on Aurora, which
 * exposes no tenant DELETE at all (lib/aurora/aurora-orchestrator.ts) — it
 * disables the tenant, which renders every key inert without revoking any of
 * them. So the key here survives with no DynamoDB row pointing at it, which is
 * why this is logged at error with the ids an operator needs.
 */
async function cleanOrphanedKeys({
  orgId,
  tenantId,
  keyId,
  orchestrator,
}: CompensateOrphanedKeyParams): Promise<void> {
  console.warn(
    '[create-access-key] Deletion guard rejected the key record mid-flight; revoking the key just minted',
    { orgId, tenantId, keyId, orchestrator: orchestrator.id },
  );
  try {
    await orchestrator.deleteAccessKey(tenantId, keyId);
  } catch (error) {
    console.error(
      '[create-access-key] Compensating revoke FAILED — a live upstream key has no DynamoDB record; the teardown disables the tenant, which renders it inert, but the key itself is never revoked and needs manual follow-up',
      { orgId, tenantId, keyId, orchestrator: orchestrator.id, error },
    );
  }
}

interface RecoverDuplicateKeyParams {
  orgId: string;
  tenantId: string;
  keyName: string;
  region: S3Region;
  orchestrator: ServiceOrchestrator;
}

async function recoverDuplicateKey({
  orgId,
  tenantId,
  keyName,
  region,
  orchestrator,
}: RecoverDuplicateKeyParams): Promise<void> {
  // Check if we already have a DynamoDB record for this key
  const { Items: existingKeys } = await getDynamoClient().send(
    new QueryCommand({
      TableName: Resource.UserInfoTable.name,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: `ORG#${orgId}` },
        ':skPrefix': { S: 'ACCESSKEY#' },
      },
    }),
  );

  const alreadyInDb = existingKeys?.some((item) => {
    const itemRegion = (item.region?.S as S3Region | undefined) ?? S3Region.EuWest1;
    return item.keyName?.S === keyName && itemRegion === region;
  });
  if (alreadyInDb) {
    return; // Simple duplicate — nothing to recover
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
    return;
  }

  // Fenced like the main path, but with NO compensating revoke: this key was
  // not minted by this request — it already existed upstream — so revoking it
  // would destroy a credential this handler never created. Skipping the write
  // is the whole remedy: teardown disables the tenant, which renders the key
  // inert (Aurora exposes no tenant DELETE and never revokes user-issued keys,
  // see lib/aurora/aurora-orchestrator.ts), and the key had no DynamoDB row
  // before this request either, so nothing is made worse.
  try {
    await sendGuardedWrite(orgId, [
      {
        Put: {
          TableName: Resource.UserInfoTable.name,
          Item: marshall({
            pk: `ORG#${orgId}`,
            sk: `ACCESSKEY#${recovered.id}`,
            keyName,
            accessKeyId: recovered.accessKeyId,
            createdAt: recovered.createdAt,
            status: 'active',
            region,
          }),
        },
      },
    ]);
  } catch (err) {
    if (!(err instanceof OrgDeletingError)) throw err;
    console.warn(
      '[create-access-key] Skipping duplicate-key recovery record: org deletion in progress',
      { orgId, keyName, keyId: recovered.id },
    );
    return;
  }

  console.log(
    `Recovered DynamoDB record for access key "${keyName}" (id=${recovered.id}) for org ${orgId} using ${orchestrator.id} orchestrator`,
  );
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(errorHandlerMiddleware());
