import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { UsageResponse, TenantStatus } from '@filone/shared';
import { ResponseBuilder } from '../lib/response-builder.js';
import { getProvisionedRegions } from '../lib/region-helpers.js';
import type { ServiceOrchestrator, TenantInfo } from '../lib/service-orchestrator.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

// Account-wide quotas. These are GLOBAL and CONSTANT — the displayed limit is
// the same regardless of how many regions an org is provisioned in, and is not
// summed per region. The displayed access-key limit reserves one system
// `filone-console` key for each of the two regions: 300 − 2 = 298.
const GLOBAL_BUCKET_LIMIT = 100;
const GLOBAL_ACCESS_KEY_LIMIT = 300;

interface RegionUsage {
  /** Most-recent storage reading for the region (point-in-time). */
  storageBytes: number;
  objectCount: number;
  /** Total egress over the window for the region. */
  egressBytes: number;
  info: TenantInfo;
}

export async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { orgId } = getUserInfo(event);

  // The dashboard aggregates usage across every region the org is provisioned
  // in, so resolve the ready tenant on each available orchestrator.
  const regions = await getProvisionedRegions(orgId);

  if (regions.length === 0) {
    const response: UsageResponse = {
      storage: { usedBytes: 0 },
      egress: { usedBytes: 0 },
      buckets: { count: 0, limit: GLOBAL_BUCKET_LIMIT },
      objects: { count: 0 },
      accessKeys: { count: 0, limit: GLOBAL_ACCESS_KEY_LIMIT - 2 },
    };
    return new ResponseBuilder().status(200).body(response).build();
  }

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime());
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);

  // Swallow per-orchestrator errors so one region's outage still renders the
  // rest: settle every fetch, log the failures, and keep the successes.
  const settled = await Promise.allSettled(
    regions.map(({ orchestrator, tenantId }) =>
      fetchRegionUsage(orchestrator, tenantId, thirtyDaysAgo, now),
    ),
  );

  const regionUsages: RegionUsage[] = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      regionUsages.push(result.value);
      return;
    }
    const { orchestrator, tenantId } = regions[i];
    console.error('[get-usage] Failed to fetch usage', {
      orgId,
      tenantId,
      region: orchestrator.region,
      err: result.reason,
    });
  });

  if (regionUsages.length === 0) {
    const response: UsageResponse = {
      storage: { usedBytes: 0 },
      egress: { usedBytes: 0 },
      buckets: { count: 0, limit: GLOBAL_BUCKET_LIMIT },
      objects: { count: 0 },
      accessKeys: { count: 0, limit: GLOBAL_ACCESS_KEY_LIMIT - 2 },
    };
    return new ResponseBuilder().status(200).body(response).build();
  }

  const response = aggregateRegionUsages(regionUsages);

  return new ResponseBuilder().status(200).body(response).build();
}

// Folds the per-region usages into the dashboard totals. Counts (storage,
// egress, objects, buckets, keys) are summed; storage/egress are pre-reduced
// per region (see `fetchRegionUsage`); status collapses to the most-restrictive
// across regions. The limit is global and constant (always `300 − 2`, never
// summed or adjusted by provisioned-region count). The system `filone-console`
// key present in each provisioned region is subtracted from the key *count*
// only, so users see just the keys they manage.
function aggregateRegionUsages(regionUsages: RegionUsage[]): UsageResponse {
  let storageUsedBytes = 0;
  let objectCount = 0;
  let egressUsedBytes = 0;
  let bucketCount = 0;
  let rawKeyCount = 0;
  let statuses: TenantStatus[] = [];

  for (const r of regionUsages) {
    storageUsedBytes += r.storageBytes;
    objectCount += r.objectCount;
    egressUsedBytes += r.egressBytes;
    bucketCount += r.info.bucketCount;
    rawKeyCount += r.info.keyCount;
    if (r.info.status) statuses.push(r.info.status);
  }

  return {
    storage: { usedBytes: storageUsedBytes },
    egress: { usedBytes: egressUsedBytes },
    buckets: { count: bucketCount, limit: GLOBAL_BUCKET_LIMIT },
    objects: { count: objectCount },
    accessKeys: {
      count: Math.max(0, rawKeyCount - regionUsages.length),
      limit: GLOBAL_ACCESS_KEY_LIMIT - 2,
    },
    tenantStatus: pickMostRestrictiveStatus(statuses),
  };
}

async function fetchRegionUsage(
  orchestrator: ServiceOrchestrator,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<RegionUsage> {
  const [metrics, info] = await Promise.all([
    orchestrator.getTenantUsageMetrics(tenantId, {
      from: from.toISOString(),
      to: to.toISOString(),
      interval: '1d',
    }),
    orchestrator.getTenantInfo(tenantId),
  ]);

  // Storage is point-in-time: take the most recent reading. Egress is
  // cumulative: sum the whole series for the window total.
  const latestStorage = metrics.storage.reduce<(typeof metrics.storage)[number] | undefined>(
    (latest, s) => (!latest || s.timestamp > latest.timestamp ? s : latest),
    undefined,
  );
  const egressBytes = metrics.egress.reduce((sum, e) => sum + e.bytesUsed, 0);

  return {
    storageBytes: latestStorage?.bytesUsed ?? 0,
    objectCount: latestStorage?.objectCount ?? 0,
    egressBytes,
    info,
  };
}

// Returns the most-restrictive status present, or `undefined` when none of the
// regions report a status we model.
function pickMostRestrictiveStatus(
  statuses: (TenantStatus | undefined)[],
): TenantStatus | undefined {
  // Tenant statuses ordered most- to least-restrictive: when regions disagree,
  // the dashboard reflects the most restrictive status in effect anywhere.
  return (['disabled', 'write-locked', 'active'] as const).find((s) => statuses.includes(s));
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(errorHandlerMiddleware());
