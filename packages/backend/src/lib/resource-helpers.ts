import type { TenantInfo } from './service-orchestrator.js';
import { getProvisionedRegions } from './region-helpers.js';
import { ResourceCountUnavailableError } from './errors.js';

export interface OrgResourceCounts {
  bucketCount: number;
  /** Self-managed keys: raw total minus one reserved `filone-console` key per fetched region. */
  accessKeyCount: number;
}

/** Single source of truth for the reserved-key subtraction. `infos` = the
 *  successfully-fetched per-region TenantInfo; one console key excluded per region. */
export function aggregateResourceCounts(infos: TenantInfo[]): OrgResourceCounts {
  let bucketCount = 0;
  let rawKeyCount = 0;
  for (const info of infos) {
    bucketCount += info.bucketCount;
    rawKeyCount += info.keyCount;
  }
  return { bucketCount, accessKeyCount: Math.max(0, rawKeyCount - infos.length) };
}

/** Current global resource counts for an org across all provisioned regions.
 *  Fails CLOSED: if ANY provisioned region's getTenantInfo rejects, throws
 *  ResourceCountUnavailableError instead of returning a partial (under-reported)
 *  count — otherwise a regional outage would silently let an org bypass its
 *  global limits. Used by the create handlers, which translate the error into a
 *  retryable 503. The dashboard (get-usage) deliberately does NOT use this: it
 *  tolerates partial failures via aggregateResourceCounts so one region's outage
 *  still renders the rest. */
export async function getOrgResourceCounts(orgId: string): Promise<OrgResourceCounts> {
  const regions = await getProvisionedRegions(orgId);
  if (regions.length === 0) return { bucketCount: 0, accessKeyCount: 0 };

  const settled = await Promise.allSettled(
    regions.map(({ orchestrator, tenantId }) => orchestrator.getTenantInfo(tenantId)),
  );

  const infos: TenantInfo[] = [];
  let hasFailure = false;
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      infos.push(result.value);
      return;
    }
    hasFailure = true;
    console.error('[getOrgResourceCounts] Failed to fetch tenant info', {
      orgId,
      tenantId: regions[i].tenantId,
      region: regions[i].orchestrator.region,
      err: result.reason,
    });
  });

  // Fail closed: enforcing a global limit on an incomplete count could let the
  // org exceed it. Surface a retryable error rather than under-counting.
  if (hasFailure) throw new ResourceCountUnavailableError();

  return aggregateResourceCounts(infos);
}
