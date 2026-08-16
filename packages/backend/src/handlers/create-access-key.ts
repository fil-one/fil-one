import { PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import {
  ApiErrorCode,
  CreateAccessKeySchema,
  S3Region,
  excessKeyPermissions,
  isSupportedRegion,
} from '@filone/shared';
import type {
  CreateAccessKeyRequest,
  CreateAccessKeyResponse,
  ErrorResponse,
  ExcessKeyPermission,
} from '@filone/shared';
import { Resource } from 'sst';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.js';
import { AccessKeyAlreadyExistsError, AccessKeyValidationError } from '../lib/errors.js';
import type { IssuedAccessKey, ServiceOrchestrator } from '../lib/service-orchestrator.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { isOrgDeleting } from '../lib/org-profile.js';
import {
  accountDeletedResponse,
  ResponseBuilder,
  tenantNotReadyResponse,
  unsupportedRegionResponse,
} from '../lib/response-builder.js';
import { keyAttribution } from '../lib/dynamo-records.js';
import type { AccessKeyRecord } from '../lib/dynamo-records.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireMembershipMiddleware, requirePermission } from '../middleware/authorize.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

// TODO: Refactor the handler, reducing its complexity and removing the ignore eslint directive.
// https://linear.app/filecoin-foundation/issue/FIL-320/refactor-create-access-key-handler
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const parsed = parseRequest(event.body);
  if ('error' in parsed) return parsed.error;

  const { keyName, permissions, granularPermissions, bucketScope, region } = parsed.request;
  const buckets = bucketScope === 'specific' ? (parsed.request.buckets ?? []) : undefined;
  const expiresAt = parsed.request.expiresAt ?? null;

  const denied = checkKeyPermissions(event, parsed.request);
  if (denied) return denied;

  const { orgId, userId } = getUserInfo(event);
  const attribution = keyAttribution({ userId, creatorEmail: getVerifiedEmail(event) });

  if (!isSupportedRegion(region, process.env.FILONE_STAGE!)) {
    return unsupportedRegionResponse(region);
  }

  // Before ensureTenantReady: the key is minted upstream, so a fence checked
  // only at the DynamoDB write would leave a live credential behind.
  if (await isOrgDeleting(orgId, { consistent: true })) return accountDeletedResponse();

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
      await recoverDuplicateKey({ orgId, tenantId, keyName, region, orchestrator, attribution });
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

  await getDynamoClient().send(
    new PutItemCommand({
      TableName: Resource.UserInfoTable.name,
      Item: buildAccessKeyItem({
        orgId,
        accessKey,
        keyName,
        region,
        permissions,
        granularPermissions,
        bucketScope,
        buckets,
        expiresAt,
        attribution,
      }),
    }),
  );

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

function buildAccessKeyItem({
  orgId,
  accessKey,
  keyName,
  region,
  permissions,
  granularPermissions,
  bucketScope,
  buckets,
  expiresAt,
  attribution,
}: {
  orgId: string;
  accessKey: IssuedAccessKey;
  keyName: string;
  region: S3Region;
  permissions: CreateAccessKeyRequest['permissions'];
  granularPermissions: CreateAccessKeyRequest['granularPermissions'];
  bucketScope: CreateAccessKeyRequest['bucketScope'];
  buckets: string[] | undefined;
  expiresAt: string | null;
  attribution: Pick<AccessKeyRecord, 'createdBy' | 'creatorEmail' | 'policyVersion'>;
}) {
  return marshall({
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
    ...attribution,
  });
}

/** The request body, or the 400 that says why it is not one. */
function parseRequest(
  rawBody: string | undefined,
): { request: CreateAccessKeyRequest } | { error: APIGatewayProxyStructuredResultV2 } {
  let body: unknown;
  try {
    body = JSON.parse(rawBody ?? '{}');
  } catch {
    return {
      error: new ResponseBuilder()
        .status(400)
        .body<ErrorResponse>({ message: 'Invalid JSON body' })
        .build(),
    };
  }

  const parsed = CreateAccessKeySchema.safeParse(body);
  if (!parsed.success) {
    return {
      error: new ResponseBuilder()
        .status(400)
        .body<ErrorResponse>({ message: parsed.error.issues[0].message })
        .build(),
    };
  }

  return { request: parsed.data };
}

/**
 * Two checks, in the order a denial should read.
 *
 * First `keys.create`, the entry gate — a ReadOnly member mints no keys at all.
 * Then the creator-authority cap: the requested key permissions are intersected
 * with the caller's own, so a key can never carry more than the member minting
 * it. Without the cap the console matrix is decoration, because a SigV4 key is
 * redeemed over S3 where no role check runs until M3: a Member denied
 * `buckets.delete` in the console would simply mint a key and delete buckets
 * with it.
 *
 * The denial names the offending permissions, because "your role does not
 * permit this key" against a form with eight checkboxes is not actionable.
 */
function checkKeyPermissions(
  event: AuthenticatedEvent,
  request: CreateAccessKeyRequest,
): APIGatewayProxyStructuredResultV2 | undefined {
  const denied = requirePermission(event, 'keys.create');
  if (denied) return denied;

  const excess = excessKeyPermissions(getUserInfo(event).membership?.role ?? '', request);
  if (excess.length === 0) return undefined;

  return new ResponseBuilder()
    .status(403)
    .body<ErrorResponse>({
      message: `A key cannot carry more than you do. Your role does not permit: ${nameExcess(excess)}.`,
      code: ApiErrorCode.FORBIDDEN_ROLE,
    })
    .build();
}

function nameExcess(excess: ExcessKeyPermission[]): string {
  return excess.map(({ keyPermission }) => keyPermission).join(', ');

}

interface RecoverDuplicateKeyParams {
  orgId: string;
  tenantId: string;
  keyName: string;
  region: S3Region;
  orchestrator: ServiceOrchestrator;
  attribution: Pick<AccessKeyRecord, 'createdBy' | 'creatorEmail' | 'policyVersion'>;
}

async function recoverDuplicateKey({
  orgId,
  tenantId,
  keyName,
  region,
  orchestrator,
  attribution,
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

  await getDynamoClient().send(
    new PutItemCommand({
      TableName: Resource.UserInfoTable.name,
      Item: marshall({
        pk: `ORG#${orgId}`,
        sk: `ACCESSKEY#${recovered.id}`,
        keyName,
        accessKeyId: recovered.accessKeyId,
        createdAt: recovered.createdAt,
        status: 'active',
        region,
        // Attributed to the caller who retried, which in practice is the same
        // person whose first attempt minted the key at the provider. A key with
        // no owner at all is the worse outcome, and `recovered` keeps the
        // record honest about which of the two this is.
        ...attribution,
        recovered: true,
      }),
    }),
  );

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
  .use(requireMembershipMiddleware())
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(errorHandlerMiddleware());
