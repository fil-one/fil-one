import { GetItemCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { CreateAccessKeySchema } from '@filone/shared';
import type { CreateAccessKeyResponse, ErrorResponse } from '@filone/shared';
import { Resource } from 'sst';
import {
  AuroraValidationError,
  createAuroraAccessKey,
  DuplicateKeyNameError,
  findAuroraAccessKeyByName,
} from '../lib/aurora-portal.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { isOrgSetupComplete } from '../lib/org-setup-status.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

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

  const {
    keyName,
    permissions,
    bucketScope,
    buckets: bucketList,
    expiresAt: expiresAtRaw,
  } = parsed.data;
  const buckets = bucketScope === 'specific' ? (bucketList ?? []) : undefined;
  const expiresAt = expiresAtRaw ?? null;

  const { orgId } = getUserInfo(event);

  // Look up org profile to get auroraTenantId
  const { Item: orgProfile } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
    }),
  );

  const auroraTenantId = orgProfile?.auroraTenantId?.S;
  const setupStatus = orgProfile?.setupStatus?.S;
  if (!auroraTenantId || !isOrgSetupComplete(setupStatus)) {
    console.warn('Aurora tenant setup is not complete', { orgId, auroraTenantId, setupStatus });
    return new ResponseBuilder()
      .status(503)
      .body<ErrorResponse>({
        message: 'Aurora tenant setup is not complete, please try again later',
      })
      .build();
  }

  let auroraKey;
  try {
    auroraKey = await createAuroraAccessKey({
      tenantId: auroraTenantId,
      keyName,
      permissions,
      buckets,
      expiresAt,
    });
  } catch (err) {
    if (err instanceof DuplicateKeyNameError) {
      await recoverDuplicateKey(orgId, auroraTenantId, keyName);
      return new ResponseBuilder()
        .status(409)
        .body<ErrorResponse>({ message: 'An access key with this name already exists' })
        .build();
    }
    if (err instanceof AuroraValidationError) {
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
        sk: `ACCESSKEY#${auroraKey.id}`,
        keyName,
        accessKeyId: auroraKey.accessKeyId,
        createdAt: auroraKey.createdAt,
        status: 'active',
        permissions,
        bucketScope,
        ...(buckets ? { buckets } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      }),
    }),
  );

  return new ResponseBuilder()
    .status(201)
    .body<CreateAccessKeyResponse>({
      id: auroraKey.id,
      keyName,
      accessKeyId: auroraKey.accessKeyId,
      secretAccessKey: auroraKey.accessKeySecret,
      createdAt: auroraKey.createdAt,
    })
    .build();
}

async function recoverDuplicateKey(
  orgId: string,
  auroraTenantId: string,
  keyName: string,
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

  // Partial failure: Aurora key exists but DynamoDB record is missing.
  // Recover by fetching key details from Aurora and writing the DB record.
  const auroraKey = await findAuroraAccessKeyByName({
    tenantId: auroraTenantId,
    keyName,
  });

  if (!auroraKey) {
    // Shouldn't happen — Aurora returned 409 but key not found in list.
    // Just return and let the user see the 409 message.
    console.error(
      `Aurora returned 409 for key "${keyName}" but key not found in Aurora list for tenant ${auroraTenantId}`,
    );
    return;
  }

  await getDynamoClient().send(
    new PutItemCommand({
      TableName: Resource.UserInfoTable.name,
      Item: marshall({
        pk: `ORG#${orgId}`,
        sk: `ACCESSKEY#${auroraKey.id}`,
        keyName,
        accessKeyId: auroraKey.accessKeyId,
        createdAt: auroraKey.createdAt,
        status: 'active',
      }),
    }),
  );

  console.log(
    `Recovered DynamoDB record for Aurora access key "${keyName}" (id=${auroraKey.id}) for org ${orgId}`,
  );
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(errorHandlerMiddleware());
