import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ErrorResponse, UploadObjectRequest, UploadObjectResponse } from '@hyperspace/shared';
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
  if (!bucketName) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Missing bucket name in path' })
      .build();
  }

  let request: UploadObjectRequest;
  try {
    request = JSON.parse(event.body ?? '{}') as UploadObjectRequest;
  } catch {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Invalid JSON body' })
      .build();
  }

  const { key, fileBase64, fileName, contentType, description } = request;
  if (!key || !fileBase64 || !fileName || !contentType) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({
        message: 'Missing required fields: key, fileBase64, fileName, contentType',
      })
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

  // Upload file to S3
  const fileBuffer = Buffer.from(fileBase64, 'base64');
  const s3Key = `${bucketName}/${key}`;
  const storage = new FileStorageClient(Resource.UserFilesBucket.name);
  const { etag } = await storage.put(s3Key, fileBuffer, contentType);

  // Store metadata in DynamoDB
  const now = new Date().toISOString();
  await dynamo.send(
    new PutItemCommand({
      TableName: tableName,
      Item: marshall({
        pk: `BUCKET#${userId}#${bucketName}`,
        sk: `OBJECT#${key}`,
        key,
        fileName,
        contentType,
        sizeBytes: fileBuffer.length,
        uploadedAt: now,
        etag,
        s3Key,
        ...(description && { description }),
      }),
    }),
  );

  return new ResponseBuilder()
    .status(201)
    .body<UploadObjectResponse>({
      uploadUrl: '',
      object: {
        key,
        sizeBytes: fileBuffer.length,
        lastModified: now,
        etag,
        contentType,
        ...(description && { description }),
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
