import { QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { RecentActivity, RecentActivityResponse } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { keyScope, withinScope } from '../lib/key-scope.js';
import type { KeyScope } from '../lib/key-scope.js';
import type { ServiceOrchestrator } from '../lib/service-orchestrator.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import type { AccessKeyRecord } from '../lib/dynamo-records.js';
import { type ProvisionedRegion, getProvisionedRegions } from '../lib/region-helpers.js';
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

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const handlerStart = performance.now();
  const { orgId } = getUserInfo(event);
  const limit = Math.min(
    Math.max(parseInt(event.queryStringParameters?.limit ?? '10', 10) || 10, 1),
    50,
  );
  // The route requirement (`buckets.read`) is only half the gate: this feed
  // carries key-lifecycle entries, and it shows them under the same scope the
  // keys pages do — the whole org's under `keys.manage_all`, the caller's own
  // under `keys.manage_own`, and none at all for a ReadOnly member who holds
  // neither. The rows are not fetched at all in that last case: a read nobody
  // may see is a read worth not making.
  const scope = keyScope(event);
  // The dashboard aggregates activity across every region the org is provisioned
  // in, so resolve the ready tenant on each available orchestrator.
  const { result: regions, durationMs: resolveRegionsMs } = await timed('resolveRegions', () =>
    getProvisionedRegions(orgId),
  );

  const [
    { result: bucketActivities, durationMs: bucketActivitiesMs },
    { result: keyActivities, durationMs: keyActivitiesMs },
  ] = await Promise.all([
    timed('fetchBucketActivities', () => fetchBucketActivities(orgId, regions)),
    // Timed only when it runs: a phase duration emitted for a fetch that was
    // skipped reports a 0ms DynamoDB query that never happened.
    scope.sees === 'none'
      ? Promise.resolve({ result: [] as RecentActivity[], durationMs: 0 })
      : timed('fetchAccessKeyActivities', () => fetchAccessKeyActivities(orgId, scope)),
  ]);

  // TODO: Re-add object activities once we have an event system with Aurora.
  // https://linear.app/filecoin-foundation/issue/FIL-77/object-sealing-live-updates-dashboard

  const activities = [...bucketActivities, ...keyActivities].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  const response: RecentActivityResponse = {
    activities: activities.slice(0, limit),
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
    const buckets = await orchestrator.listBuckets(tenantId);
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

async function fetchAccessKeyActivities(orgId: string, scope: KeyScope): Promise<RecentActivity[]> {
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
  return (keysResult.Items ?? [])
    .map((item) => unmarshall(item) as AccessKeyRecord)
    .filter((key) => withinScope(scope, key))
    .map((key) => ({
      id: `key-${key.sk.replace('ACCESSKEY#', '')}`,
      action: 'key.created' as const,
      resourceType: 'key' as const,
      resourceName: key.keyName,
      timestamp: key.createdAt,
    }));
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('buckets.read'))
  .use(errorHandlerMiddleware());
