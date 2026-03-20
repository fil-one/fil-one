import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ErrorResponse, ListObjectsResponse } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { getAuroraS3Credentials, listObjects } from '../lib/aurora-s3-client.js';
import { isOrgSetupComplete } from '../lib/org-setup-status.js';
import { isNoSuchBucketError } from '../lib/s3-errors.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

const dynamo = getDynamoClient();

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const bucketName = event.pathParameters?.name;
  if (!bucketName) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Missing bucket name in path' })
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

  const stage = process.env.FILONE_STAGE!;
  const gatewayUrl = process.env.AURORA_S3_GATEWAY_URL!;

  const credentials = await getAuroraS3Credentials(stage, auroraTenantId);

  const prefix = event.queryStringParameters?.prefix;
  const delimiter = event.queryStringParameters?.delimiter;
  const maxKeys = event.queryStringParameters?.maxKeys
    ? parseInt(event.queryStringParameters.maxKeys, 10)
    : undefined;
  const nextToken = event.queryStringParameters?.nextToken;

  let result;
  try {
    result = await listObjects({
      endpointUrl: gatewayUrl,
      credentials,
      bucket: bucketName,
      prefix,
      delimiter,
      maxKeys,
      continuationToken: nextToken,
    });
  } catch (err) {
    if (isNoSuchBucketError(err)) {
      return new ResponseBuilder()
        .status(404)
        .body<ErrorResponse>({ message: 'Bucket not found' })
        .build();
    }
    throw err;
  }

  return new ResponseBuilder()
    .status(200)
    .body<ListObjectsResponse>({
      objects: result.objects,
      nextToken: result.nextToken,
      isTruncated: result.isTruncated,
    })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
