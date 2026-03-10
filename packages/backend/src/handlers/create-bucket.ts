import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { CreateBucketRequest, CreateBucketResponse, ErrorResponse } from '@hyperspace/shared';
import { Resource } from 'sst';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { subscriptionGuardMiddleware, AccessLevel } from '../middleware/subscription-guard.js';

const dynamo = new DynamoDBClient({});

const BUCKET_NAME_REGEX = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
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

  const { userId } = getUserInfo(event);
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
