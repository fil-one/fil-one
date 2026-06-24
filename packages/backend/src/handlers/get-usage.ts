import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { UsageResponse, TenantStatus } from '@filone/shared';
import { GLOBAL_BUCKET_LIMIT, GLOBAL_ACCESS_KEY_LIMIT } from '@filone/shared';
import { ResponseBuilder } from '../lib/response-builder.js';
import { getProvisionedRegions } from '../lib/region-helpers.js';
import { aggregateResourceCounts } from '../lib/resource-helpers.js';
import type { ServiceOrchestrator, TenantInfo } from '../lib/service-orchestrator.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

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
      accessKeys: { count: 0, limit: GLOBAL_ACCESS_KEY_LIMIT },
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
      accessKeys: { count: 0, limit: GLOBAL_ACCESS_KEY_LIMIT },
    };
    return new ResponseBuilder().status(200).body(response).build();
  }

  const response = aggregateRegionUsages(regionUsages);

  return new ResponseBuilder().status(200).body(response).build();
}

// Folds the per-region usages into the dashboard totals. Storage, egress, and
// objects are summed (storage/egress are pre-reduced per region — see
// `fetchRegionUsage`); bucket and key counts come from the shared
// `aggregateResourceCounts` helper (which subtracts the reserved
// `filone-console` key per region from the key count only). The limits are
// global constants (300 / 100), never summed or adjusted by provisioned-region
// count. Status collapses to the most-restrictive across regions.
function aggregateRegionUsages(regionUsages: RegionUsage[]): UsageResponse {
  let storageUsedBytes = 0;
  let objectCount = 0;
  let egressUsedBytes = 0;
  let statuses: TenantStatus[] = [];

  for (const r of regionUsages) {
    storageUsedBytes += r.storageBytes;
    objectCount += r.objectCount;
    egressUsedBytes += r.egressBytes;
    if (r.info.status) statuses.push(r.info.status);
  }

  const counts = aggregateResourceCounts(regionUsages.map((r) => r.info));

  return {
    storage: { usedBytes: storageUsedBytes },
    egress: { usedBytes: egressUsedBytes },
    buckets: { count: counts.bucketCount, limit: GLOBAL_BUCKET_LIMIT },
    objects: { count: objectCount },
    accessKeys: {
      count: counts.accessKeyCount,
      limit: GLOBAL_ACCESS_KEY_LIMIT,
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
