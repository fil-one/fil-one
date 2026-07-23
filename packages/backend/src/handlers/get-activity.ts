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
import { reportMetric } from '../lib/metrics.js';

const dynamo = getDynamoClient();

// Emit a duration data point via EMF so per-phase / per-region latency can be
// charted and alarmed on in CloudWatch (see the SLO on this handler). The keys
// of `dimensions` become the metric's CloudWatch dimensions.
function reportDuration(
  metricName: string,
  dimensions: Record<string, string>,
  durationMs: number,
): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [Object.keys(dimensions)],
          Metrics: [{ Name: metricName, Unit: 'Milliseconds' }],
        },
      ],
    },
    ...dimensions,
    [metricName]: durationMs,
  });
}

// Times an awaited phase, emits its duration as a metric, and hands back both
// the result and the elapsed ms so the caller can log a combined summary.
async function timed<T>(
  phase: string,
  fn: () => Promise<T>,
): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  try {
    const result = await fn();
    const durationMs = performance.now() - start;
    reportDuration('GetActivityPhaseDuration', { handler: 'get-activity', phase }, durationMs);
    return { result, durationMs };
  } catch (err) {
    const durationMs = performance.now() - start;
    reportDuration(
      'GetActivityPhaseDuration',
      { handler: 'get-activity', phase: `${phase}:error` },
      durationMs,
    );
    throw err;
  }
}

function endOfDay(d: Date): Date {
  const eod = new Date(d);
  eod.setUTCHours(23, 59, 59, 999);
  return eod;
}

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const handlerStart = performance.now();
  const { orgId } = getUserInfo(event);
  const limit = Math.min(
    Math.max(parseInt(event.queryStringParameters?.limit ?? '10', 10) || 10, 1),
    50,
  );
  const period = event.queryStringParameters?.period === '30d' ? 30 : 7;

  // The dashboard aggregates activity across every region the org is provisioned
  // in, so resolve the ready tenant on each available orchestrator.
  const { result: regions, durationMs: resolveRegionsMs } = await timed('resolveRegions', () =>
    getProvisionedRegions(orgId),
  );

  const [
    { result: bucketActivities, durationMs: bucketActivitiesMs },
    { result: keyActivities, durationMs: keyActivitiesMs },
    { result: trends, durationMs: trendsMs },
  ] = await Promise.all([
    timed('fetchBucketActivities', () => fetchBucketActivities(orgId, regions)),
    timed('fetchAccessKeyActivities', () => fetchAccessKeyActivities(orgId)),
    timed('buildTimeSeries', () => buildTimeSeries(regions, period)),
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

  const totalMs = performance.now() - handlerStart;
  reportDuration('GetActivityDuration', { handler: 'get-activity' }, totalMs);
  // Single summary line so a slow request shows which phase dominated without
  // stitching together the per-phase metrics. Phases run concurrently, so the
  // total is ~max(phases), not their sum.
  console.log('[get-activity] completed', {
    orgId,
    regionCount: regions.length,
    regions: regions.map((r) => r.orchestrator.region),
    bucketActivityCount: bucketActivities.length,
    keyActivityCount: keyActivities.length,
    durationsMs: {
      total: Math.round(totalMs),
      resolveRegions: Math.round(resolveRegionsMs),
      fetchBucketActivities: Math.round(bucketActivitiesMs),
      fetchAccessKeyActivities: Math.round(keyActivitiesMs),
      buildTimeSeries: Math.round(trendsMs),
    },
  });

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
  const start = performance.now();
  try {
    // This feed only reads bucketName/createdAt, so skip the per-bucket
    // versioning lookups (an N+1 on FTH) that would otherwise dominate latency.
    const buckets = await orchestrator.listBuckets(tenantId, { includeVersioning: false });
    const durationMs = performance.now() - start;
    reportDuration('ListBucketsDuration', { region: orchestrator.region }, durationMs);
    // bucketCount vs durationMs exposes the per-bucket cost — a duration that
    // grows with bucketCount points at an N+1 in the orchestrator's listBuckets.
    console.log('[get-activity] listed buckets', {
      orgId,
      tenantId,
      region: orchestrator.region,
      bucketCount: buckets.length,
      durationMs: Math.round(durationMs),
    });
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
  const start = performance.now();
  try {
    const { storage } = await orchestrator.getTenantUsageMetrics(tenantId, {
      from: from.toISOString(),
      to: to.toISOString(),
      interval: '1d',
    });
    const durationMs = performance.now() - start;
    reportDuration('GetTenantUsageMetricsDuration', { region: orchestrator.region }, durationMs);
    console.log('[get-activity] fetched usage metrics', {
      tenantId,
      region: orchestrator.region,
      sampleCount: storage.length,
      durationMs: Math.round(durationMs),
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
