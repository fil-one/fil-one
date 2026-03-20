import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { CreateBucketRequest, CreateBucketResponse, ErrorResponse } from '@filone/shared';
import { S3_REGION } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { createAuroraBucket, BucketAlreadyExistsError } from '../lib/aurora-portal.js';
import { isOrgSetupComplete } from '../lib/org-setup-status.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

const dynamo = getDynamoClient();

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

  if (region !== S3_REGION) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: `Unsupported region. Supported: ${S3_REGION}` })
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

  const { orgId } = getUserInfo(event);

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
    console.error('Aurora tenant setup is not complete', { orgId, auroraTenantId, setupStatus });
    return new ResponseBuilder()
      .status(503)
      .body<ErrorResponse>({
        message: 'Aurora tenant setup is not complete, please try again later',
      })
      .build();
  }

  try {
    await createAuroraBucket({ tenantId: auroraTenantId, bucketName: name });
  } catch (err) {
    if (err instanceof BucketAlreadyExistsError) {
      return new ResponseBuilder()
        .status(409)
        .body<ErrorResponse>({ message: `Bucket "${name}" already exists` })
        .build();
    }
    throw err;
  }

  const now = new Date().toISOString();

  return new ResponseBuilder()
    .status(201)
    .body<CreateBucketResponse>({
      bucket: {
        name,
        region,
        createdAt: now,
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
