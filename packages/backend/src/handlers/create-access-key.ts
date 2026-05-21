import { PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { CreateAccessKeySchema, S3_REGION } from '@filone/shared';
import type { CreateAccessKeyResponse, ErrorResponse } from '@filone/shared';
import { Resource } from 'sst';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.js';
import {
  AccessKeyAlreadyExistsError,
  AccessKeyValidationError,
  IssuedAccessKey,
  ServiceOrchestrator,
} from '../lib/service-orchestrator.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { ResponseBuilder, tenantNotReadyResponse } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

// TODO: Refactor the handler, reducing its complexity and removing the ignore eslint directive.
// https://linear.app/filecoin-foundation/issue/FIL-320/refactor-create-access-key-handler
// eslint-disable-next-line complexity/complexity
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

  // Phase A: only the Aurora region is supported in handlers. Phase B will
  // open this up via getAvailableRegions(stage) once the FTH
  // orchestrator is registered.
  if (region !== undefined && region !== S3_REGION) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: `Unsupported region. Supported: ${S3_REGION}` })
      .build();
  }

  const { orgId } = getUserInfo(event);

  const orchestrator = getOrchestratorForRegion(S3_REGION);
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
      await recoverDuplicateKey(orgId, tenantId, keyName, orchestrator);
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
      Item: marshall({
        pk: `ORG#${orgId}`,
        sk: `ACCESSKEY#${accessKey.id}`,
        keyName,
        accessKeyId: accessKey.accessKeyId,
        createdAt: accessKey.createdAt,
        status: 'active',
        permissions,
        ...(granularPermissions?.length ? { granularPermissions } : {}),
        bucketScope,
        ...(buckets ? { buckets } : {}),
        ...(expiresAt ? { expiresAt } : {}),
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

async function recoverDuplicateKey(
  orgId: string,
  tenantId: string,
  keyName: string,
  orchestrator: ServiceOrchestrator,
): Promise<void> {
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

  const alreadyInDb = existingKeys?.some((item) => item.keyName?.S === keyName);
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
      }),
    }),
  );

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
