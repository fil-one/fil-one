import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { UsageDataPoint, UsageTrendsResponse } from '@filone/shared';
import type { ServiceOrchestrator, StorageUsageSample } from '../lib/service-orchestrator.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { ProvisionedRegion, getProvisionedRegions } from '../lib/region-helpers.js';

function endOfDay(d: Date): Date {
  const eod = new Date(d);
  eod.setUTCHours(23, 59, 59, 999);
  return eod;
}

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId } = getUserInfo(event);
  const period = event.queryStringParameters?.period === '30d' ? 30 : 7;

  // The dashboard aggregates usage across every region the org is provisioned
  // in, so resolve the ready tenant on each available orchestrator.
  const regions = await getProvisionedRegions(orgId);

  const response: UsageTrendsResponse = await buildTimeSeries(regions, period);
  return new ResponseBuilder().status(200).body(response).build();
}

async function buildTimeSeries(
  regions: ProvisionedRegion[],
  period: number,
): Promise<UsageTrendsResponse> {
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
    console.error('[get-usage-trends] Failed to fetch usage metrics', {
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
