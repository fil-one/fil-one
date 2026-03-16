import { QueryCommand } from '@aws-sdk/client-dynamodb';
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
import type { BucketRecord, ObjectRecord } from '../lib/dynamo-records.js';

const dynamo = getDynamoClient();

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

  // TODO: Integrate with aurora to get the definitive form of this data.
  // https://linear.app/filecoin-foundation/issue/FIL-68/create-a-data-summary-api
  // This is not a scalable way to do this and currently only accounts for our console uploaded files

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

  const response: UsageResponse = {
    storage: {
      usedBytes: storageUsedBytes,
    },
    egress: {
      // TODO: implement egress: https://linear.app/filecoin-foundation/issue/FIL-82/get-egress-from-aurora
      usedBytes: 0,
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
