import { DynamoDBClient, DeleteItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ErrorResponse } from '@filone/shared';
import { Resource } from 'sst';
import { FileStorageClient } from '../lib/file-storage-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

const dynamo = new DynamoDBClient({});

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const bucketName = event.pathParameters?.name;
  const objectKey = event.queryStringParameters?.key;

  if (!bucketName) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Missing bucket name in path' })
      .build();
  }

  if (!objectKey) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Missing object key query parameter' })
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

  // Get object metadata to find s3Key
  const objectRecord = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: marshall({
        pk: `BUCKET#${userId}#${bucketName}`,
        sk: `OBJECT#${objectKey}`,
      }),
    }),
  );

  if (!objectRecord.Item) {
    return new ResponseBuilder()
      .status(404)
      .body<ErrorResponse>({ message: 'Object not found' })
      .build();
  }

  const record = unmarshall(objectRecord.Item);
  const s3Key = record.s3Key as string;

  // Delete from S3
  const storage = new FileStorageClient(Resource.UserFilesBucket.name);
  await storage.delete(s3Key);

  // Delete from DynamoDB
  await dynamo.send(
    new DeleteItemCommand({
      TableName: tableName,
      Key: marshall({
        pk: `BUCKET#${userId}#${bucketName}`,
        sk: `OBJECT#${objectKey}`,
      }),
    }),
  );

  return {
    statusCode: 204,
    body: '',
  };
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(errorHandlerMiddleware());
