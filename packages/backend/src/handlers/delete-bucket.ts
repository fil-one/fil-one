import { DynamoDBClient, DeleteItemCommand, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ErrorResponse } from '@hyperspace/shared';
import { Resource } from "sst";
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
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

  // Verify ownership
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

  // Check bucket is empty
  const objects = await dynamo.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: `BUCKET#${userId}#${bucketName}` },
        ':skPrefix': { S: 'OBJECT#' },
      },
      Limit: 1,
    }),
  );

  if (objects.Items && objects.Items.length > 0) {
    return new ResponseBuilder()
      .status(409)
      .body<ErrorResponse>({ message: 'Bucket must be empty before deletion' })
      .build();
  }

  // Delete the bucket record
  await dynamo.send(
    new DeleteItemCommand({
      TableName: tableName,
      Key: marshall({ pk: `USER#${userId}`, sk: `BUCKET#${bucketName}` }),
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
