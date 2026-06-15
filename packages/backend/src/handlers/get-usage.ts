import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { UsageResponse } from '@filone/shared';
import { ResponseBuilder } from '../lib/response-builder.js';
import { getProvisionedRegions } from '../lib/region-helpers.js';
import type { ServiceOrchestrator, TenantInfo, TenantStatus } from '../lib/service-orchestrator.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

// Defaults shown before any tenant is provisioned. `299` mirrors the
// `300 − 1` console-key reservation applied once a tenant exists.
const DEFAULT_BUCKET_LIMIT = 100;
const DEFAULT_ACCESS_KEY_LIMIT = 299;

// A tenant is provisioned on the first bucket creation in a region, which also
// creates one system `filone-console` key; reserve a slot per provisioned
// region so users see only the keys they manage.
const RESERVED_KEYS_PER_REGION = 1;

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
      buckets: { count: 0, limit: DEFAULT_BUCKET_LIMIT },
      objects: { count: 0 },
      accessKeys: { count: 0, limit: DEFAULT_ACCESS_KEY_LIMIT },
    };
    return new ResponseBuilder().status(200).body(response).build();
  }

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime());
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);

  const regionUsages = (
    await Promise.all(
      regions.map(({ orchestrator, tenantId }) =>
        fetchRegionUsage(orgId, orchestrator, tenantId, thirtyDaysAgo, now),
      ),
    )
  ).filter((r): r is RegionUsage => r !== null);

  const response = aggregateRegionUsages(regionUsages);

  return new ResponseBuilder().status(200).body(response).build();
}

// Folds the per-region usages into the dashboard totals. Counts and limits are
// summed; storage/egress are pre-reduced per region (see `fetchRegionUsage`);
// status collapses to the most-restrictive across regions. The system
// `filone-console` key (one per provisioned region, created with the tenant on
// the region's first bucket creation) is subtracted from access key counts and
// limits so users see only the keys they manage.
function aggregateRegionUsages(regionUsages: RegionUsage[]): UsageResponse {
  let storageUsedBytes = 0;
  let objectCount = 0;
  let egressUsedBytes = 0;
  let bucketCount = 0;
  let bucketLimit = 0;
  let rawKeyCount = 0;
  let rawKeyLimit = 0;
  let statuses: TenantStatus[] = [];

  for (const r of regionUsages) {
    storageUsedBytes += r.storageBytes;
    objectCount += r.objectCount;
    egressUsedBytes += r.egressBytes;
    bucketCount += r.info.bucketCount;
    bucketLimit += r.info.bucketLimit;
    rawKeyCount += r.info.keyCount;
    rawKeyLimit += r.info.accessKeyLimit;
    if (r.info.status) statuses.push(r.info.status);
  }

  const reserved = regionUsages.length * RESERVED_KEYS_PER_REGION;

  return {
    storage: { usedBytes: storageUsedBytes },
    egress: { usedBytes: egressUsedBytes },
    buckets: { count: bucketCount, limit: bucketLimit },
    objects: { count: objectCount },
    accessKeys: {
      count: Math.max(0, rawKeyCount - reserved),
      limit: Math.max(0, rawKeyLimit - reserved),
    },
    tenantStatus: pickMostRestrictiveStatus(statuses),
  };
}

// Swallow per-orchestrator errors so one region's outage still renders the rest.
async function fetchRegionUsage(
  orgId: string,
  orchestrator: ServiceOrchestrator,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<RegionUsage | null> {
  try {
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
  } catch (err) {
    console.error('[get-usage] Failed to fetch usage', {
      orgId,
      tenantId,
      region: orchestrator.region,
      err,
    });
    return null;
  }
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
