import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantInfo } from './service-orchestrator.js';

const mockGetProvisionedRegions = vi.fn();
vi.mock('./region-helpers.js', () => ({
  getProvisionedRegions: (...args: unknown[]) => mockGetProvisionedRegions(...args),
}));

import { aggregateResourceCounts, getOrgResourceCounts } from './resource-helpers.js';

function tenantInfo(overrides: Partial<TenantInfo> = {}): TenantInfo {
  return {
    bucketCount: 0,
    bucketLimit: 100,
    keyCount: 0,
    accessKeyLimit: 300,
    ...overrides,
  };
}

describe('aggregateResourceCounts', () => {
  it('returns zeros for an empty list', () => {
    expect(aggregateResourceCounts([])).toEqual({ bucketCount: 0, accessKeyCount: 0 });
  });

  it('sums buckets and subtracts one reserved console key per region', () => {
    const counts = aggregateResourceCounts([
      tenantInfo({ bucketCount: 1, keyCount: 4 }),
      tenantInfo({ bucketCount: 2, keyCount: 2 }),
    ]);
    // buckets: 1 + 2 = 3; keys: (4 + 2) − 2 reserved = 4.
    expect(counts).toEqual({ bucketCount: 3, accessKeyCount: 4 });
  });

  it('floors the reserved-key subtraction at 0', () => {
    const counts = aggregateResourceCounts([tenantInfo({ keyCount: 0 })]);
    expect(counts.accessKeyCount).toBe(0);
  });
});

describe('getOrgResourceCounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns zeros when the org has no provisioned regions', async () => {
    mockGetProvisionedRegions.mockResolvedValue([]);

    expect(await getOrgResourceCounts('org-1')).toEqual({ bucketCount: 0, accessKeyCount: 0 });
  });

  it('aggregates counts across all provisioned regions', async () => {
    mockGetProvisionedRegions.mockResolvedValue([
      {
        tenantId: 'aurora:org-1',
        orchestrator: {
          region: 'eu-west-1',
          getTenantInfo: vi.fn().mockResolvedValue(tenantInfo({ bucketCount: 2, keyCount: 3 })),
        },
      },
      {
        tenantId: 'fth:org-1',
        orchestrator: {
          region: 'us-east-1',
          getTenantInfo: vi.fn().mockResolvedValue(tenantInfo({ bucketCount: 1, keyCount: 2 })),
        },
      },
    ]);

    // buckets: 2 + 1 = 3; keys: (3 + 2) − 2 reserved = 3.
    expect(await getOrgResourceCounts('org-1')).toEqual({ bucketCount: 3, accessKeyCount: 3 });
  });

  it('skips a region whose getTenantInfo rejects and logs the failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetProvisionedRegions.mockResolvedValue([
      {
        tenantId: 'aurora:org-1',
        orchestrator: {
          region: 'eu-west-1',
          getTenantInfo: vi.fn().mockResolvedValue(tenantInfo({ bucketCount: 2, keyCount: 3 })),
        },
      },
      {
        tenantId: 'fth:org-1',
        orchestrator: {
          region: 'us-east-1',
          getTenantInfo: vi.fn().mockRejectedValue(new Error('region down')),
        },
      },
    ]);

    // Only the surviving region counts: buckets 2, keys 3 − 1 reserved = 2.
    const counts = await getOrgResourceCounts('org-1');
    expect(counts).toEqual({ bucketCount: 2, accessKeyCount: 2 });
    expect(errorSpy).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });
});
