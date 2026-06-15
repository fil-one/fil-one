import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { UsageResponse } from '@filone/shared';
import { ResponseBuilder } from '../lib/response-builder.js';
import { getProvisionedRegions } from '../lib/region-helpers.js';
import type { ServiceOrchestrator, TenantInfo } from '../lib/service-orchestrator.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

// Defaults shown before any tenant is provisioned. `299` mirrors the
// `300 − 1` console-key reservation applied once a tenant exists.
const DEFAULT_BUCKET_LIMIT = 100;
const DEFAULT_ACCESS_KEY_LIMIT = 299;

// Most-restrictive wins when combining tenant statuses across regions.
const STATUS_SEVERITY: Record<NonNullable<TenantInfo['status']>, number> = {
  disabled: 2,
  'write-locked': 1,
  active: 0,
};

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

  const perRegion = (
    await Promise.all(
      regions.map(({ orchestrator, tenantId }) =>
        fetchRegionUsage(orgId, orchestrator, tenantId, thirtyDaysAgo, now),
      ),
    )
  ).filter((r): r is RegionUsage => r !== null);

  let storageUsedBytes = 0;
  let objectCount = 0;
  let egressUsedBytes = 0;
  let bucketCount = 0;
  let bucketLimit = 0;
  let rawKeyCount = 0;
  let rawKeyLimit = 0;
  let status: TenantInfo['status'];

  for (const r of perRegion) {
    storageUsedBytes += r.storageBytes;
    objectCount += r.objectCount;
    egressUsedBytes += r.egressBytes;
    bucketCount += r.info.bucketCount;
    bucketLimit += r.info.bucketLimit;
    rawKeyCount += r.info.keyCount;
    rawKeyLimit += r.info.accessKeyLimit;
    status = mostRestrictive(status, r.info.status);
  }

  // Reserve one slot per tenant for the system `filone-console` key created
  // during onboarding, so users see counts/limits relative to keys they manage.
  const reserved = perRegion.length;
  const accessKeyCount = Math.max(0, rawKeyCount - reserved);
  const accessKeyLimit = Math.max(0, rawKeyLimit - reserved);

  const response: UsageResponse = {
    storage: { usedBytes: storageUsedBytes },
    egress: { usedBytes: egressUsedBytes },
    buckets: { count: bucketCount, limit: bucketLimit },
    objects: { count: objectCount },
    accessKeys: { count: accessKeyCount, limit: accessKeyLimit },
    tenantStatus: status,
  };

  return new ResponseBuilder().status(200).body(response).build();
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

function mostRestrictive(a: TenantInfo['status'], b: TenantInfo['status']): TenantInfo['status'] {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return STATUS_SEVERITY[a] >= STATUS_SEVERITY[b] ? a : b;
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(errorHandlerMiddleware());
