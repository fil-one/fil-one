import { QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ActivityResponse, RecentActivity, UsageDataPoint } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import type { ServiceOrchestrator, StorageUsageSample } from '../lib/service-orchestrator.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import type { AccessKeyRecord } from '../lib/dynamo-records.js';
import { ProvisionedRegion, getProvisionedRegions } from '../lib/region-helpers.js';

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

  // The dashboard aggregates activity across every region the org is provisioned
  // in, so resolve the ready tenant on each available orchestrator.
  const regions = await getProvisionedRegions(orgId);

  const [bucketActivities, keyActivities, trends] = await Promise.all([
    fetchBucketActivities(orgId, regions),
    fetchAccessKeyActivities(orgId),
    buildTimeSeries(regions, period),
  ]);

  // TODO: Re-add object activities once we have an event system with Aurora.
  // https://linear.app/filecoin-foundation/issue/FIL-77/object-sealing-live-updates-dashboard

  const activities = [...bucketActivities, ...keyActivities].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  const response: ActivityResponse = {
    activities: activities.slice(0, limit),
    trends,
  };
  return new ResponseBuilder().status(200).body(response).build();
}

async function fetchBucketActivities(
  orgId: string,
  regions: ProvisionedRegion[],
): Promise<RecentActivity[]> {
  const perRegion = await Promise.all(
    regions.map(({ orchestrator, tenantId }) =>
      listBucketActivities(orgId, orchestrator, tenantId),
    ),
  );
  return perRegion.flat();
}

async function listBucketActivities(
  orgId: string,
  orchestrator: ServiceOrchestrator,
  tenantId: string,
): Promise<RecentActivity[]> {
  // Swallow per-orchestrator errors so one region's outage still renders the rest.
  try {
    const buckets = await orchestrator.listBuckets(tenantId);
    return buckets.map((bucket) => ({
      id: `bucket-${bucket.bucketName}`,
      action: 'bucket.created' as const,
      resourceType: 'bucket' as const,
      resourceName: bucket.bucketName,
      timestamp: bucket.createdAt,
    }));
  } catch (err) {
    const errName = (err as { name?: string }).name;
    const errCode = (err as { Code?: string }).Code;
    if (errName === 'AccessDenied' || errCode === 'AccessDenied') {
      console.warn('[get-activity] AccessDenied listing buckets — tenant may have no buckets yet', {
        orgId,
        tenantId,
        region: orchestrator.region,
      });
    } else {
      console.error('[get-activity] Failed to list buckets', {
        orgId,
        tenantId,
        region: orchestrator.region,
        err,
      });
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
  regions: ProvisionedRegion[],
  period: number,
): Promise<ActivityResponse['trends']> {
  const now = new Date();
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - period + 1);
  from.setUTCHours(0, 0, 0, 0);

  // Fetch each region's storage series and index it by end-of-day, then sum
  // across regions per day for the org-wide trend.
  const perRegionByDate = await Promise.all(
    regions.map(({ orchestrator, tenantId }) =>
      fetchStorageByDate(orchestrator, tenantId, from, now),
    ),
  );

  // Build full date range with gap-filling, summing all regions for each day.
  const storage: UsageDataPoint[] = [];
  const objects: UsageDataPoint[] = [];
  for (const d = new Date(from); d <= now; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = endOfDay(d).toISOString();
    let bytesUsed = 0;
    let objectCount = 0;
    for (const byDate of perRegionByDate) {
      const sample = byDate.get(date);
      bytesUsed += sample?.bytesUsed ?? 0;
      objectCount += sample?.objectCount ?? 0;
    }
    storage.push({ date, value: bytesUsed });
    objects.push({ date, value: objectCount });
  }

  return { storage, objects };
}

async function fetchStorageByDate(
  orchestrator: ServiceOrchestrator,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<Map<string, StorageUsageSample>> {
  // Request 1d granularity: one point per day, which is the resolution this trend
  // renders at. The end-of-day key still collapses each day to a single reading,
  // and since upstream ordering isn't guaranteed we keep the sample with the
  // greatest timestamp per day rather than relying on insertion order. Swallow
  // errors so one region's outage still renders the rest.
  try {
    const { storage } = await orchestrator.getTenantUsageMetrics(tenantId, {
      from: from.toISOString(),
      to: to.toISOString(),
      interval: '1d',
    });
    const byDate = new Map<string, StorageUsageSample>();
    for (const s of storage) {
      const key = endOfDay(new Date(s.timestamp)).toISOString();
      const existing = byDate.get(key);
      // Sample timestamps are canonical ISO-8601 UTC (normalized by the
      // orchestrator), so lexicographic order matches chronological order.
      if (!existing || s.timestamp > existing.timestamp) {
        byDate.set(key, s);
      }
    }
    return byDate;
  } catch (err) {
    console.error('[get-activity] Failed to fetch usage metrics', {
      tenantId,
      region: orchestrator.region,
      err,
    });
    return new Map();
  }
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(errorHandlerMiddleware());
