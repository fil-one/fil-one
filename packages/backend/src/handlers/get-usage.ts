import { QueryCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { UsageResponse } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import type { BucketRecord, ObjectRecord, SubscriptionRecord } from '../lib/dynamo-records.js';
import { SubscriptionStatus } from '../lib/dynamo-records.js';

const dynamo = getDynamoClient();
const TIB_BYTES = 1099511627776;

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { userId, orgId } = getUserInfo(event);
  const uploadsTableName = Resource.UploadsTable.name;

  // 1. Query all buckets
  const bucketsResult = await dynamo.send(
    new QueryCommand({
      TableName: uploadsTableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: `USER#${userId}` },
        ':skPrefix': { S: 'BUCKET#' },
      },
    }),
  );
  const buckets = (bucketsResult.Items ?? []).map((item) => unmarshall(item) as BucketRecord);

  // 2. Sum object sizes + count across all buckets
  let storageUsedBytes = 0;
  let objectCount = 0;
  for (const bucket of buckets) {
    const objectsResult = await dynamo.send(
      new QueryCommand({
        TableName: uploadsTableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': { S: `BUCKET#${userId}#${bucket.name}` },
          ':skPrefix': { S: 'OBJECT#' },
        },
        ProjectionExpression: 'sizeBytes',
      }),
    );
    for (const item of objectsResult.Items ?? []) {
      const obj = unmarshall(item) as Pick<ObjectRecord, 'sizeBytes'>;
      storageUsedBytes += obj.sizeBytes || 0;
      objectCount++;
    }
  }

  // 3. Count access keys (stored in UserInfoTable with ORG# pk and ACCESSKEY# sk prefix)
  const keysResult = await dynamo.send(
    new QueryCommand({
      TableName: Resource.UserInfoTable.name,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: `ORG#${orgId}` },
        ':skPrefix': { S: 'ACCESSKEY#' },
      },
      Select: 'COUNT',
    }),
  );

  // 4. Determine storage limit based on subscription status
  const billingResult = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.BillingTable.name,
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
      ProjectionExpression: 'subscriptionStatus',
    }),
  );
  const billingRecord = billingResult.Item
    ? (unmarshall(billingResult.Item) as Pick<SubscriptionRecord, 'subscriptionStatus'>)
    : null;
  const isActive = billingRecord?.subscriptionStatus === SubscriptionStatus.Active;

  const response: UsageResponse = {
    storage: {
      usedBytes: storageUsedBytes,
      limitBytes: isActive ? -1 : TIB_BYTES,
    },
    downloads: {
      usedBytes: 0, // TODO: implement download tracking
      limitBytes: 10 * TIB_BYTES,
    },
    buckets: {
      count: buckets.length,
      limit: 100,
    },
    objects: {
      count: objectCount,
    },
    accessKeys: {
      count: keysResult.Count ?? 0,
      limit: 300,
    },
  };

  return new ResponseBuilder().status(200).body(response).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(errorHandlerMiddleware());
