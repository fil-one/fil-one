import { GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
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
import { getStorageSamples } from '../lib/aurora-backoffice.js';

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

  // Look up org profile to get auroraTenantId
  const { Item: orgProfile } = await dynamo.send(
    new GetItemCommand({
      TableName: userInfoTableName,
      Key: marshall({ pk: `ORG#${orgId}`, sk: 'PROFILE' }),
    }),
  );
  const auroraTenantId = orgProfile?.auroraTenantId?.S;

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

  // Collect activities from buckets and objects
  const activities: RecentActivity[] = [];

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

  // Fetch time series data from Aurora
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - period);
  from.setHours(0, 0, 0, 0);

  const storageSamples = auroraTenantId
    ? await getStorageSamples({
        tenantId: auroraTenantId,
        from: from.toISOString(),
        to: now.toISOString(),
        window: '24h',
      })
    : [];

  const storageSeries: UsageDataPoint[] = storageSamples.map((s) => ({
    date: s.timestamp!,
    value: s.bytesUsed ?? 0,
  }));

  const objectsSeries: UsageDataPoint[] = storageSamples.map((s) => ({
    date: s.timestamp!,
    value: s.objectCount ?? 0,
  }));

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
