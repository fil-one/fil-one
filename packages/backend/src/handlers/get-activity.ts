import { QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ActivityResponse, RecentActivity, UsageDataPoint } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import type { AccessKeyRecord, BucketRecord, ObjectRecord } from '../lib/dynamo-records.js';

const dynamo = getDynamoClient();

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { userId, orgId } = getUserInfo(event);
  const limit = Math.min(
    Math.max(parseInt(event.queryStringParameters?.limit ?? '10', 10) || 10, 1),
    50,
  );
  const period = event.queryStringParameters?.period === '30d' ? 30 : 7;
  const uploadsTableName = Resource.UploadsTable.name;
  const userInfoTableName = Resource.UserInfoTable.name;

  // Get all buckets
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

  // Collect activities and objects in a single pass over all buckets
  const activities: RecentActivity[] = [];
  const allObjects: Pick<ObjectRecord, 'sizeBytes' | 'uploadedAt'>[] = [];

  for (const bucket of buckets) {
    activities.push({
      id: `bucket-${bucket.name}`,
      action: 'bucket.created',
      resourceType: 'bucket',
      resourceName: bucket.name,
      timestamp: bucket.createdAt,
    });

    const objectsResult = await dynamo.send(
      new QueryCommand({
        TableName: uploadsTableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': { S: `BUCKET#${userId}#${bucket.name}` },
          ':skPrefix': { S: 'OBJECT#' },
        },
      }),
    );

    for (const item of objectsResult.Items ?? []) {
      const obj = unmarshall(item) as ObjectRecord;
      activities.push({
        id: `object-${bucket.name}-${obj.key}`,
        action: 'object.uploaded',
        resourceType: 'object',
        resourceName: obj.key,
        timestamp: obj.uploadedAt,
        sizeBytes: obj.sizeBytes || undefined,
        cid: obj.cid || undefined,
      });
      allObjects.push({ sizeBytes: obj.sizeBytes, uploadedAt: obj.uploadedAt });
    }
  }

  // Get access keys
  const keysResult = await dynamo.send(
    new QueryCommand({
      TableName: userInfoTableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: `ORG#${orgId}` },
        ':skPrefix': { S: 'ACCESSKEY#' },
      },
    }),
  );
  for (const item of keysResult.Items ?? []) {
    const key = unmarshall(item) as AccessKeyRecord;
    activities.push({
      id: `key-${key.sk.replace('ACCESSKEY#', '')}`,
      action: 'key.created',
      resourceType: 'key',
      resourceName: key.keyName,
      timestamp: key.createdAt,
    });
  }

  // Sort activities most-recent-first
  activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Build daily trend data points
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - period + 1);
  startDate.setHours(0, 0, 0, 0);

  allObjects.sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));

  const storageSeries: UsageDataPoint[] = [];
  const objectsSeries: UsageDataPoint[] = [];

  for (let d = 0; d < period; d++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + d);
    const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    let cumulativeStorage = 0;
    let dailyObjectCount = 0;
    for (const obj of allObjects) {
      const objDate = new Date(obj.uploadedAt);
      if (objDate <= endOfDay) cumulativeStorage += obj.sizeBytes;
      if (objDate >= date && objDate <= endOfDay) dailyObjectCount++;
    }

    storageSeries.push({ date: label, value: cumulativeStorage });
    objectsSeries.push({ date: label, value: dailyObjectCount });
  }

  const response: ActivityResponse = {
    activities: activities.slice(0, limit),
    trends: { storage: storageSeries, objects: objectsSeries },
  };
  return new ResponseBuilder().status(200).body(response).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(errorHandlerMiddleware());
