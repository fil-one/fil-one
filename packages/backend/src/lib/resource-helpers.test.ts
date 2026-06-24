import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TenantInfo } from './service-orchestrator.js';

const mockGetProvisionedRegions = vi.fn();
vi.mock('./region-helpers.js', () => ({
  getProvisionedRegions: (...args: unknown[]) => mockGetProvisionedRegions(...args),
}));

import { aggregateResourceCounts, getOrgResourceCounts } from './resource-helpers.js';
import { ResourceCountUnavailableError } from './errors.js';

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

  it('fails closed: throws and logs when any region getTenantInfo rejects', async () => {
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

    // A partial count could under-report usage and let the org exceed its global
    // limits, so enforcement must refuse rather than proceed on the survivor.
    await expect(getOrgResourceCounts('org-1')).rejects.toBeInstanceOf(
      ResourceCountUnavailableError,
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });
});
