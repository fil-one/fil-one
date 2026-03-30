import { GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ActivityResponse, RecentActivity, UsageDataPoint } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { getAuroraS3Credentials, listBuckets } from '../lib/aurora-s3-client.js';
import { isOrgSetupComplete } from '../lib/org-setup-status.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import type { AccessKeyRecord } from '../lib/dynamo-records.js';
import { getStorageSamples } from '../lib/aurora-backoffice.js';

const dynamo = getDynamoClient();

function endOfDay(d: Date): Date {
  const eod = new Date(d);
  eod.setUTCHours(23, 59, 59, 999);
  return eod;
}

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId } = getUserInfo(event);
  const limit = Math.min(
    Math.max(parseInt(event.queryStringParameters?.limit ?? '10', 10) || 10, 1),
    50,
  );
  const period = event.queryStringParameters?.period === '30d' ? 30 : 7;
  const userInfoTableName = Resource.UserInfoTable.name;

  // Look up org profile for Aurora S3 credentials
  const { Item: orgProfile } = await dynamo.send(
    new GetItemCommand({
      TableName: userInfoTableName,
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
    }),
  );

  const auroraTenantId = orgProfile?.auroraTenantId?.S;
  const setupStatus = orgProfile?.setupStatus?.S;

  // Collect activities and objects in a single pass over all buckets
  const activities: RecentActivity[] = [];

  const stage = process.env.FILONE_STAGE!;
  const gatewayUrl = process.env.AURORA_S3_GATEWAY_URL!;
  const credentials =
    auroraTenantId && isOrgSetupComplete(setupStatus)
      ? await getAuroraS3Credentials(stage, auroraTenantId)
      : undefined;

  // Get buckets from Aurora S3 — swallow errors so the dashboard still renders.
  let buckets: Awaited<ReturnType<typeof listBuckets>>['buckets'] = [];
  if (credentials) {
    try {
      buckets = (await listBuckets(gatewayUrl, credentials)).buckets;
    } catch (err) {
      const errName = (err as { name?: string }).name;
      const errCode = (err as { Code?: string }).Code;
      if (errName === 'AccessDenied' || errCode === 'AccessDenied') {
        console.warn(
          '[get-activity] AccessDenied listing buckets — tenant may have no buckets yet',
          {
            orgId,
            auroraTenantId,
          },
        );
      } else {
        console.error('[get-activity] Failed to list buckets from Aurora S3', { orgId, err });
      }
    }
  }

  for (const bucket of buckets) {
    activities.push({
      id: `bucket-${bucket.name}`,
      action: 'bucket.created',
      resourceType: 'bucket',
      resourceName: bucket.name,
      timestamp: bucket.createdAt,
    });

    // TODO: Re-add object activities once we have an event system with Aurora.
    // https://linear.app/filecoin-foundation/issue/FIL-77/object-sealing-live-updates-dashboard
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
  from.setUTCDate(from.getUTCDate() - period + 1);
  from.setUTCHours(0, 0, 0, 0);

  const storageSamples = auroraTenantId
    ? await getStorageSamples({
        tenantId: auroraTenantId,
        from: from.toISOString(),
        to: now.toISOString(),
        window: '24h',
      })
    : [];

  // Index Aurora samples by end-of-day timestamp
  const samplesByDate = new Map(
    storageSamples
      .filter((s) => s.timestamp)
      .map((s) => [endOfDay(new Date(s.timestamp!)).toISOString(), s] as const),
  );

  // Build full date range with gap-filling
  const storageSeries: UsageDataPoint[] = [];
  const objectsSeries: UsageDataPoint[] = [];
  for (const d = new Date(from); d <= now; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = endOfDay(d).toISOString();
    const sample = samplesByDate.get(date);
    storageSeries.push({ date, value: sample?.bytesUsed ?? 0 });
    objectsSeries.push({ date, value: sample?.objectCount ?? 0 });
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
