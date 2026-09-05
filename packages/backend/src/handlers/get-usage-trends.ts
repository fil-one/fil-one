import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { UsageDataPoint, UsageTrendsPeriod, UsageTrendsResponse } from '@filone/shared';
import type { ServiceOrchestrator, StorageUsageSample } from '../lib/service-orchestrator.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { ProvisionedRegion, getProvisionedRegions } from '../lib/region-helpers.js';

/**
 * How a period is bucketed.
 *
 * A day's storage reading is one number, so a week is seven points. A single
 * day has to sample hourly or there is nothing to draw, which means the bucket
 * boundary, the cursor step and the upstream interval all move together. All
 * arithmetic is UTC, so an hour is always an hour and a day is always 24 of
 * them, whatever the caller's timezone is doing.
 */
type Granularity = {
  /** Sampling interval requested from the orchestrator. */
  interval: string;
  /** Collapses a timestamp to the end of its bucket, which is the series key. */
  endOfBucket: (d: Date) => Date;
  /** Rewinds a cursor to the start of its bucket, mutating it. */
  toStartOfBucket: (d: Date) => void;
  /** Advances a cursor by one bucket, mutating it. */
  advance: (d: Date) => void;
  /** Rewinds a cursor by `n` buckets, mutating it. */
  rewind: (d: Date, n: number) => void;
};

const HOURLY: Granularity = {
  interval: '1h',
  endOfBucket: (d) => {
    const eoh = new Date(d);
    eoh.setUTCMinutes(59, 59, 999);
    return eoh;
  },
  toStartOfBucket: (d) => d.setUTCMinutes(0, 0, 0),
  advance: (d) => d.setUTCHours(d.getUTCHours() + 1),
  rewind: (d, n) => d.setUTCHours(d.getUTCHours() - n),
};

const DAILY: Granularity = {
  interval: '1d',
  endOfBucket: (d) => {
    const eod = new Date(d);
    eod.setUTCHours(23, 59, 59, 999);
    return eod;
  },
  toStartOfBucket: (d) => d.setUTCHours(0, 0, 0, 0),
  advance: (d) => d.setUTCDate(d.getUTCDate() + 1),
  rewind: (d, n) => d.setUTCDate(d.getUTCDate() - n),
};

/** Buckets per period, and the granularity each is sampled at. */
const TREND_WINDOWS: Record<UsageTrendsPeriod, { points: number; granularity: Granularity }> = {
  '24h': { points: 24, granularity: HOURLY },
  '7d': { points: 7, granularity: DAILY },
  '30d': { points: 30, granularity: DAILY },
};

const DEFAULT_PERIOD: UsageTrendsPeriod = '7d';

function parsePeriod(raw: string | undefined): UsageTrendsPeriod {
  return raw !== undefined && raw in TREND_WINDOWS ? (raw as UsageTrendsPeriod) : DEFAULT_PERIOD;
}

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId } = getUserInfo(event);
  const period = parsePeriod(event.queryStringParameters?.period);

  // The dashboard aggregates usage across every region the org is provisioned
  // in, so resolve the ready tenant on each available orchestrator.
  const regions = await getProvisionedRegions(orgId);

  const response: UsageTrendsResponse = await buildTimeSeries(regions, period);
  return new ResponseBuilder().status(200).body(response).build();
}

async function buildTimeSeries(
  regions: ProvisionedRegion[],
  period: UsageTrendsPeriod,
): Promise<UsageTrendsResponse> {
  const { points, granularity } = TREND_WINDOWS[period];
  const now = new Date();
  const from = new Date(now);
  granularity.rewind(from, points - 1);
  granularity.toStartOfBucket(from);

  // Fetch each region's series and index them by bucket, then sum across
  // regions per bucket for the org-wide trend.
  const perRegion = await Promise.all(
    regions.map(({ orchestrator, tenantId }) =>
      fetchSamplesByBucket({ orchestrator, tenantId, from, to: now, granularity }),
    ),
  );

  // Build the full range with gap-filling, summing all regions for each bucket.
  const storage: UsageDataPoint[] = [];
  const objects: UsageDataPoint[] = [];
  const egress: UsageDataPoint[] = [];
  for (const d = new Date(from); d <= now; granularity.advance(d)) {
    const date = granularity.endOfBucket(d).toISOString();
    let bytesUsed = 0;
    let objectCount = 0;
    let egressBytes = 0;
    for (const region of perRegion) {
      const sample = region.storage.get(date);
      bytesUsed += sample?.bytesUsed ?? 0;
      objectCount += sample?.objectCount ?? 0;
      egressBytes += region.egress.get(date) ?? 0;
    }
    storage.push({ date, value: bytesUsed });
    objects.push({ date, value: objectCount });
    egress.push({ date, value: egressBytes });
  }

  return { storage, objects, egress };
}

type FetchSamplesArgs = {
  orchestrator: ServiceOrchestrator;
  tenantId: string;
  from: Date;
  to: Date;
  granularity: Granularity;
};

type SamplesByBucket = {
  /** End-of-bucket key to the bucket's closing storage reading. */
  storage: Map<string, StorageUsageSample>;
  /** End-of-bucket key to the bytes served during that bucket. */
  egress: Map<string, number>;
};

/**
 * Storage and egress are indexed differently, and the difference is the whole
 * point.
 *
 * Storage is a stock: a reading of what the account holds at an instant. Two
 * readings in one bucket are two observations of the same quantity, so the
 * later one wins and the earlier is discarded.
 *
 * Egress is a flow: bytes served *during* an interval. Two readings in one
 * bucket are two separate deliveries, so they add. Taking the latest here would
 * silently drop traffic, and on the metric that disables an account over its
 * trial cap (FIL-869) that is not a rounding error.
 */
async function fetchSamplesByBucket({
  orchestrator,
  tenantId,
  from,
  to,
  granularity,
}: FetchSamplesArgs): Promise<SamplesByBucket> {
  // Swallow errors so one region's outage still renders the rest.
  try {
    const { storage, egress } = await orchestrator.getTenantUsageMetrics(tenantId, {
      from: from.toISOString(),
      to: to.toISOString(),
      interval: granularity.interval,
    });

    const storageByBucket = new Map<string, StorageUsageSample>();
    for (const s of storage) {
      const key = granularity.endOfBucket(new Date(s.timestamp)).toISOString();
      const existing = storageByBucket.get(key);
      // Sample timestamps are canonical ISO-8601 UTC (normalized by the
      // orchestrator), so lexicographic order matches chronological order.
      if (!existing || s.timestamp > existing.timestamp) {
        storageByBucket.set(key, s);
      }
    }

    const egressByBucket = new Map<string, number>();
    for (const e of egress) {
      const key = granularity.endOfBucket(new Date(e.timestamp)).toISOString();
      egressByBucket.set(key, (egressByBucket.get(key) ?? 0) + e.bytesUsed);
    }

    return { storage: storageByBucket, egress: egressByBucket };
  } catch (err) {
    console.error('[get-usage-trends] Failed to fetch usage metrics', {
      tenantId,
      region: orchestrator.region,
      err,
    });
    return { storage: new Map(), egress: new Map() };
  }
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('buckets.read'))
  .use(errorHandlerMiddleware());
