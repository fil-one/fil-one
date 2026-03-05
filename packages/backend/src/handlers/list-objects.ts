import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ErrorResponse, ListObjectsResponse, S3Object } from '@hyperspace/shared';
import { Resource } from "sst";
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

const dynamo = new DynamoDBClient({});

async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyResultV2> {
  const bucketName = event.pathParameters?.name;
  if (!bucketName) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Missing bucket name in path' })
      .build();
  }

  const { userId } = getUserInfo(event);
  const tableName = Resource.UploadsTable.name;

  // Verify bucket ownership
  const bucketRecord = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: marshall({ pk: `USER#${userId}`, sk: `BUCKET#${bucketName}` }),
    }),
  );

  if (!bucketRecord.Item) {
    return new ResponseBuilder()
      .status(404)
      .body<ErrorResponse>({ message: 'Bucket not found' })
      .build();
  }

  // List objects
  const result = await dynamo.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: `BUCKET#${userId}#${bucketName}` },
        ':skPrefix': { S: 'OBJECT#' },
      },
    }),
  );

  const objects: S3Object[] = (result.Items ?? []).map((item) => {
    const record = unmarshall(item);
    return {
      key: record.key as string,
      sizeBytes: record.sizeBytes as number,
      lastModified: record.uploadedAt as string,
      etag: record.etag as string,
      contentType: record.contentType as string,
      cid: record.cid as string | undefined,
      description: record.description as string | undefined,
    };
  });

  return new ResponseBuilder()
    .status(200)
    .body<ListObjectsResponse>({
      objects,
      isTruncated: false,
    })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Read))
  .use(errorHandlerMiddleware());
