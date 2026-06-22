import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockGetAvailableOrchestrators = vi.fn();
vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getAvailableOrchestrators: (...args: unknown[]) => mockGetAvailableOrchestrators(...args),
}));

vi.mock('../lib/org-profile.js', () => ({
  getOrgProfile: vi.fn(async (orgId: string) => fakeOrgProfile(orgId)),
}));

process.env.FILONE_STAGE = 'test';

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './get-usage.js';
import { buildEvent } from '../test/lambda-test-utilities.js';
import { fakeOrchestrator, fakeOrgProfile, tenantFor } from '../test/fake-orchestrator.js';
import { S3Region } from '@filone/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1', email: 'user@example.com' };
// fakeOrchestrator derives the tenant id from the orgId in the PROFILE item.
const AURORA_TENANT_ID = tenantFor('aurora', USER_INFO.orgId);
const FTH_TENANT_ID = tenantFor('fth', USER_INFO.orgId);

function authenticatedEvent() {
  return buildEvent({ userInfo: USER_INFO });
}

async function run() {
  const result = await baseHandler(authenticatedEvent());
  return JSON.parse(String((result as { body: string }).body));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('get-usage baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('returns usage data from a single Aurora region', async () => {
    const aurora = fakeOrchestrator('aurora', {
      region: S3Region.EuWest1,
      storage: [{ timestamp: '2026-01-01T00:00:00.000Z', bytesUsed: 4000, objectCount: 3 }],
      egress: [{ timestamp: '2026-01-01T00:00:00.000Z', bytesUsed: 1500 }],
      info: { bucketCount: 2, bucketLimit: 50, keyCount: 3, accessKeyLimit: 200 },
    });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const body = await run();

    // Limits are global constants, not the per-region values reported above.
    expect(body).toStrictEqual({
      storage: { usedBytes: 4000 },
      egress: { usedBytes: 1500 },
      buckets: { count: 2, limit: 100 },
      objects: { count: 3 },
      accessKeys: { count: 2, limit: 298 },
    });
  });

  it('hides the system filone-console key from access key counts', async () => {
    const aurora = fakeOrchestrator('aurora', {
      region: S3Region.EuWest1,
      info: { bucketCount: 0, bucketLimit: 100, keyCount: 1, accessKeyLimit: 300 },
    });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const body = await run();

    expect(body.accessKeys).toEqual({ count: 0, limit: 298 });
  });

  it('returns defaults when no region is provisioned', async () => {
    const aurora = fakeOrchestrator('aurora', { region: S3Region.EuWest1, ready: false });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const body = await run();

    expect(body).toStrictEqual({
      storage: { usedBytes: 0 },
      egress: { usedBytes: 0 },
      buckets: { count: 0, limit: 100 },
      objects: { count: 0 },
      accessKeys: { count: 0, limit: 298 },
    });
    expect(aurora.getTenantUsageMetrics).not.toHaveBeenCalled();
    expect(aurora.getTenantInfo).not.toHaveBeenCalled();
  });

  it('returns zeros (with the provisioned tenant defaults) when samples are empty', async () => {
    const aurora = fakeOrchestrator('aurora', {
      region: S3Region.EuWest1,
      info: { bucketCount: 0, bucketLimit: 100, keyCount: 0, accessKeyLimit: 300 },
    });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const body = await run();

    expect(body).toStrictEqual({
      storage: { usedBytes: 0 },
      egress: { usedBytes: 0 },
      buckets: { count: 0, limit: 100 },
      objects: { count: 0 },
      accessKeys: { count: 0, limit: 298 },
    });
  });

  it('uses the latest storage sample and sums the egress series', async () => {
    const aurora = fakeOrchestrator('aurora', {
      region: S3Region.EuWest1,
      storage: [
        { timestamp: '2026-01-01T00:00:00.000Z', bytesUsed: 1000, objectCount: 2 },
        { timestamp: '2026-01-15T00:00:00.000Z', bytesUsed: 5000, objectCount: 8 },
      ],
      egress: [
        { timestamp: '2026-01-01T00:00:00.000Z', bytesUsed: 100 },
        { timestamp: '2026-01-15T00:00:00.000Z', bytesUsed: 250 },
      ],
    });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const body = await run();

    expect(body.storage.usedBytes).toBe(5000);
    expect(body.objects.count).toBe(8);
    expect(body.egress.usedBytes).toBe(350);
  });

  it('sums usage and counts across all provisioned regions; limits stay constant', async () => {
    const aurora = fakeOrchestrator('aurora', {
      region: S3Region.EuWest1,
      storage: [{ timestamp: '2026-01-15T00:00:00.000Z', bytesUsed: 1000, objectCount: 5 }],
      egress: [{ timestamp: '2026-01-15T00:00:00.000Z', bytesUsed: 200 }],
      info: { bucketCount: 2, bucketLimit: 100, keyCount: 4, accessKeyLimit: 300 },
    });
    const fth = fakeOrchestrator('fth', {
      region: S3Region.UsEast1,
      storage: [{ timestamp: '2026-01-15T00:00:00.000Z', bytesUsed: 500, objectCount: 1 }],
      egress: [{ timestamp: '2026-01-15T00:00:00.000Z', bytesUsed: 50 }],
      info: { bucketCount: 1, bucketLimit: 100, keyCount: 2, accessKeyLimit: 300 },
    });
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

    const body = await run();

    expect(body.storage.usedBytes).toBe(1500);
    expect(body.objects.count).toBe(6);
    expect(body.egress.usedBytes).toBe(250);
    expect(body.buckets).toEqual({ count: 3, limit: 100 });
    // keys: (4 + 2) − 2 console keys (one per region) = 4; limit is the
    // constant global ceiling: 300 − 2 = 298.
    expect(body.accessKeys).toEqual({ count: 4, limit: 298 });

    expect(aurora.getTenantUsageMetrics).toHaveBeenCalledWith(AURORA_TENANT_ID, expect.any(Object));
    expect(fth.getTenantInfo).toHaveBeenCalledWith(FTH_TENANT_ID);
  });

  it('surfaces the most-restrictive tenant status across regions', async () => {
    const aurora = fakeOrchestrator('aurora', {
      region: S3Region.EuWest1,
      info: { status: 'active' },
    });
    const fth = fakeOrchestrator('fth', {
      region: S3Region.UsEast1,
      info: { status: 'write-locked' },
    });
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

    const body = await run();

    expect(body.tenantStatus).toBe('write-locked');
  });

  it('still renders other regions when one orchestrator fails', async () => {
    const aurora = fakeOrchestrator('aurora', {
      region: S3Region.EuWest1,
      storage: [{ timestamp: '2026-01-15T00:00:00.000Z', bytesUsed: 1000, objectCount: 5 }],
      info: { bucketCount: 2, bucketLimit: 100, keyCount: 3, accessKeyLimit: 300 },
    });
    const fth = fakeOrchestrator('fth', { region: S3Region.UsEast1, failUsage: true });
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

    const body = await run();

    expect(body.storage.usedBytes).toBe(1000);
    expect(body.buckets).toEqual({ count: 2, limit: 100 });
    // Only the surviving region's console key is hidden from the count: 3 − 1 = 2.
    // The limit is the constant global ceiling: 300 − 2 = 298.
    expect(body.accessKeys).toEqual({ count: 2, limit: 298 });
  });

  it('returns defaults when every provisioned region fails to fetch usage', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const aurora = fakeOrchestrator('aurora', { region: S3Region.EuWest1, failUsage: true });
    const fth = fakeOrchestrator('fth', { region: S3Region.UsEast1, failUsage: true });
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

    const result = await baseHandler(authenticatedEvent());
    const body = JSON.parse(String((result as { body: string }).body));

    // No region survives, so the response falls back to the global defaults
    // rather than erroring out: a console key is reserved per region (300 − 2 = 298).
    expect((result as { statusCode: number }).statusCode).toBe(200);
    expect(body).toStrictEqual({
      storage: { usedBytes: 0 },
      egress: { usedBytes: 0 },
      buckets: { count: 0, limit: 100 },
      objects: { count: 0 },
      accessKeys: { count: 0, limit: 298 },
    });
    // tenantStatus is omitted entirely when no region reports one.
    expect(body).not.toHaveProperty('tenantStatus');
    // Each failed region's error is logged (swallowed, not thrown).
    expect(errorSpy).toHaveBeenCalledTimes(2);

    errorSpy.mockRestore();
  });
});
