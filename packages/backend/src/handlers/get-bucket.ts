import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { Bucket } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { userId } = getUserInfo(event);
  const bucketName = event.pathParameters?.name;

  if (!bucketName) {
    return new ResponseBuilder().status(400).body({ message: 'Bucket name is required' }).build();
  }

  const result = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.UploadsTable.name,
      Key: {
        pk: { S: `USER#${userId}` },
        sk: { S: `BUCKET#${bucketName}` },
      },
    }),
  );

  if (!result.Item) {
    return new ResponseBuilder().status(404).body({ message: 'Bucket not found' }).build();
  }

  const record = unmarshall(result.Item);
  const bucket: Bucket = {
    name: record.name as string,
    region: record.region as string,
    createdAt: record.createdAt as string,
    objectCount: 0,
    sizeBytes: 0,
    isPublic: (record.isPublic as boolean) ?? false,
  };

  return new ResponseBuilder().status(200).body({ bucket }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
