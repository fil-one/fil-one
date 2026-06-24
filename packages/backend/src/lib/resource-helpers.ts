import type { TenantInfo } from './service-orchestrator.js';
import { getProvisionedRegions } from './region-helpers.js';

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
 *  Resilient: a region whose getTenantInfo fails is logged and skipped (mirrors
 *  get-usage). Used by the create handlers to enforce global limits. */
export async function getOrgResourceCounts(orgId: string): Promise<OrgResourceCounts> {
  const regions = await getProvisionedRegions(orgId);
  if (regions.length === 0) return { bucketCount: 0, accessKeyCount: 0 };

  const settled = await Promise.allSettled(
    regions.map(({ orchestrator, tenantId }) => orchestrator.getTenantInfo(tenantId)),
  );

  const infos: TenantInfo[] = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      infos.push(result.value);
      return;
    }
    console.error('[getOrgResourceCounts] Failed to fetch tenant info', {
      orgId,
      tenantId: regions[i].tenantId,
      region: regions[i].orchestrator.region,
      err: result.reason,
    });
  });

  return aggregateResourceCounts(infos);
}
