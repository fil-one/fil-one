import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ErrorResponse, UploadRequest, UploadResponse } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

const dynamo = getDynamoClient();

async function baseHandler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let request: UploadRequest;
  try {
    request = JSON.parse(event.body ?? '{}') as UploadRequest;
  } catch {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Invalid JSON body' })
      .build();
  }

  const { bucketName, key, fileName, contentType } = request;
  if (!bucketName || !key || !fileName || !contentType) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({
        message: 'Missing required fields: bucketName, key, fileName, contentType',
      })
      .build();
  }

  const uploadId = crypto.randomUUID();

  await dynamo.send(
    new PutItemCommand({
      TableName: Resource.UploadsTable.name,
      Item: marshall({
        pk: `UPLOAD#${uploadId}`,
        sk: 'METADATA',
        uploadId,
        bucketName,
        key,
        fileName,
        contentType,
        uploadedAt: new Date().toISOString(),
      }),
    }),
  );

  return new ResponseBuilder()
    .status(200)
    .body<UploadResponse>({ uploadId, bucketName, key })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(subscriptionGuardMiddleware(AccessLevel.Write))
  .use(errorHandlerMiddleware());
