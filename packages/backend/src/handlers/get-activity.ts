import { GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getS3Endpoint, S3_REGION } from '@filone/shared';
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

  // Look up org profile for Aurora S3 credentials
  const { Item: orgProfile } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
    }),
  );

  const auroraTenantId = orgProfile?.auroraTenantId?.S;
  const setupStatus = orgProfile?.setupStatus?.S;

  const [bucketActivities, keyActivities] = await Promise.all([
    fetchBucketActivities(orgId, auroraTenantId, setupStatus),
    fetchAccessKeyActivities(orgId),
  ]);

  // TODO: Re-add object activities once we have an event system with Aurora.
  // https://linear.app/filecoin-foundation/issue/FIL-77/object-sealing-live-updates-dashboard

  const activities = [...bucketActivities, ...keyActivities].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  const trends = await buildTimeSeries(auroraTenantId, period);

  const response: ActivityResponse = {
    activities: activities.slice(0, limit),
    trends,
  };
  return new ResponseBuilder().status(200).body(response).build();
}

async function fetchBucketActivities(
  orgId: string,
  auroraTenantId: string | undefined,
  setupStatus: string | undefined,
): Promise<RecentActivity[]> {
  // Swallow errors so the dashboard still renders.
  const stage = process.env.FILONE_STAGE!;
  if (!auroraTenantId || !isOrgSetupComplete(setupStatus)) return [];

  const gatewayUrl = getS3Endpoint(S3_REGION, stage);
  try {
    const credentials = await getAuroraS3Credentials(stage, auroraTenantId);
    const { buckets } = await listBuckets(gatewayUrl, credentials);
    return buckets.map((bucket) => ({
      id: `bucket-${bucket.name}`,
      action: 'bucket.created' as const,
      resourceType: 'bucket' as const,
      resourceName: bucket.name,
      timestamp: bucket.createdAt,
    }));
  } catch (err) {
    const errName = (err as { name?: string }).name;
    const errCode = (err as { Code?: string }).Code;
    if (errName === 'AccessDenied' || errCode === 'AccessDenied') {
      console.warn('[get-activity] AccessDenied listing buckets — tenant may have no buckets yet', {
        orgId,
        auroraTenantId,
      });
    } else {
      console.error('[get-activity] Failed to list buckets from Aurora S3', { orgId, err });
    }
    return [];
  }
}

async function fetchAccessKeyActivities(orgId: string): Promise<RecentActivity[]> {
  const keysResult = await dynamo.send(
    new QueryCommand({
      TableName: Resource.UserInfoTable.name,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: `ORG#${orgId}` },
        ':skPrefix': { S: 'ACCESSKEY#' },
      },
    }),
  );
  return (keysResult.Items ?? []).map((item) => {
    const key = unmarshall(item) as AccessKeyRecord;
    return {
      id: `key-${key.sk.replace('ACCESSKEY#', '')}`,
      action: 'key.created' as const,
      resourceType: 'key' as const,
      resourceName: key.keyName,
      timestamp: key.createdAt,
    };
  });
}

async function buildTimeSeries(
  auroraTenantId: string | undefined,
  period: number,
): Promise<ActivityResponse['trends']> {
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
  const storage: UsageDataPoint[] = [];
  const objects: UsageDataPoint[] = [];
  for (const d = new Date(from); d <= now; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = endOfDay(d).toISOString();
    const sample = samplesByDate.get(date);
    storage.push({ date, value: sample?.bytesUsed ?? 0 });
    objects.push({ date, value: sample?.objectCount ?? 0 });
  }

  return { storage, objects };
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(errorHandlerMiddleware());
