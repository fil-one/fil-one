import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { CreateBucketRequest, CreateBucketResponse, ErrorResponse } from '@filone/shared';
import { Resource } from 'sst';
import { createAuroraBucket } from '../lib/aurora-portal.js';
import { isOrgSetupComplete } from '../lib/org-setup-status.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

const dynamo = new DynamoDBClient({});

const BUCKET_NAME_REGEX = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  let request: CreateBucketRequest;
  try {
    request = JSON.parse(event.body ?? '{}') as CreateBucketRequest;
  } catch {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Invalid JSON body' })
      .build();
  }

  const { name, region } = request;
  if (!name || !region) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Missing required fields: name, region' })
      .build();
  }

  if (!BUCKET_NAME_REGEX.test(name)) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({
        message:
          'Bucket name must be 3-63 characters, lowercase letters, numbers, and hyphens only',
      })
      .build();
  }

  const { userId, orgId } = getUserInfo(event);

  // Look up org profile to get auroraTenantId
  const { Item: orgProfile } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
    }),
  );

  const auroraTenantId = orgProfile?.auroraTenantId?.S;
  const setupStatus = orgProfile?.setupStatus?.S;
  if (!auroraTenantId || !isOrgSetupComplete(setupStatus)) {
    return new ResponseBuilder()
      .status(503)
      .body<ErrorResponse>({
        message: 'Aurora tenant setup is not complete, please try again later',
      })
      .build();
  }

  // We create the Aurora bucket before the DynamoDB record so that:
  // 1. If Aurora fails, we haven't written any state — clean failure.
  // 2. If Aurora succeeds but DynamoDB fails, the user can safely retry:
  //    Aurora returns 409 (treated as success), then DynamoDB insert succeeds.
  // 3. If the bucket truly already exists (both Aurora and DynamoDB),
  //    Aurora 409 is treated as success, then DynamoDB conditional check
  //    catches the duplicate and we return 409 to the user.
  await createAuroraBucket({ tenantId: auroraTenantId, bucketName: name });

  const now = new Date().toISOString();

  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: Resource.UploadsTable.name,
        Item: marshall({
          pk: `USER#${userId}`,
          sk: `BUCKET#${name}`,
          name,
          region,
          createdAt: now,
          isPublic: false,
        }),
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return new ResponseBuilder()
        .status(409)
        .body<ErrorResponse>({ message: `Bucket "${name}" already exists` })
        .build();
    }
    throw err;
  }

  return new ResponseBuilder()
    .status(201)
    .body<CreateBucketResponse>({
      bucket: {
        name,
        region,
        createdAt: now,
        objectCount: 0,
        sizeBytes: 0,
        isPublic: false,
      },
    })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(errorHandlerMiddleware());
