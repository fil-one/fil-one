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
import { ensureTenantReady } from '../lib/aurora-tenant-setup.js';
import { getDynamoClient } from '../lib/ddb-client.js';
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

  const { keyName, permissions, granularPermissions, bucketScope } = parsed.data;
  const buckets = bucketScope === 'specific' ? (parsed.data.buckets ?? []) : undefined;
  const expiresAt = parsed.data.expiresAt ?? null;

  const { orgId } = getUserInfo(event);

  const ready = await prepareTenant(orgId, 'create-access-key');
  if (!ready.ok) return ready.response;
  const { auroraTenantId } = ready;

  let auroraKey;
  try {
    auroraKey = await createAuroraAccessKey({
      tenantId: auroraTenantId,
      keyName,
      permissions,
      granularPermissions,
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
      id: auroraKey.id,
      keyName,
      accessKeyId: auroraKey.accessKeyId,
      secretAccessKey: auroraKey.accessKeySecret,
      createdAt: auroraKey.createdAt,
    })
    .build();
}

type PrepareTenantResult =
  | { ok: true; auroraTenantId: string }
  | { ok: false; response: APIGatewayProxyStructuredResultV2 };

async function prepareTenant(orgId: string, handlerName: string): Promise<PrepareTenantResult> {
  const { Item: orgProfile } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
    }),
  );
  const orgName = orgProfile?.name?.S ?? '';

  try {
    const { auroraTenantId } = await ensureTenantReady({ orgId, orgName });
    return { ok: true, auroraTenantId };
  } catch (err) {
    console.error(`[tenant-setup] setup failed during ${handlerName}`, {
      orgId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return {
      ok: false,
      response: new ResponseBuilder()
        .status(503)
        .body<ErrorResponse>({
          message: "We're still setting up your account. Please try again in a moment.",
        })
        .build(),
    };
  }
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
