import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';

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
import { buildEvent, membershipFor } from '../test/lambda-test-utilities.js';
import { fakeOrchestrator, fakeOrgProfile, tenantFor } from '../test/fake-orchestrator.js';
import { OrgRole, S3Region } from '@filone/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1', email: 'user@example.com' };
// fakeOrchestrator derives the tenant id from the orgId in the PROFILE item.
const AURORA_TENANT_ID = tenantFor('aurora', USER_INFO.orgId);
const FTH_TENANT_ID = tenantFor('fth', USER_INFO.orgId);

function authenticatedEvent(role?: OrgRole) {
  return buildEvent({
    userInfo: {
      ...USER_INFO,
      ...(role ? { membership: membershipFor(USER_INFO.orgId, USER_INFO.userId, role) } : {}),
    },
  });
}

/**
 * The org's stored `ACCESSKEY#` rows. Only the attributes the count projects are
 * written, since scope is the only predicate applied to them.
 */
function stubAccessKeyRows(...rows: { createdBy?: string; recovered?: boolean }[]) {
  ddbMock.on(QueryCommand).resolves({
    Items: rows.map((row) => ({
      ...(row.createdBy ? { createdBy: { S: row.createdBy } } : {}),
      ...(row.recovered ? { recovered: { BOOL: true } } : {}),
    })),
  });
}

async function run(role?: OrgRole) {
  const result = await baseHandler(authenticatedEvent(role));
  return JSON.parse(String((result as { body: string }).body));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('get-usage baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    // Most tests here are not about keys; an org with none keeps them at zero.
    stubAccessKeyRows();
  });

  it('returns usage data from a single Aurora region', async () => {
    const aurora = fakeOrchestrator('aurora', {
      region: S3Region.EuWest1,
      storage: [{ timestamp: '2026-01-01T00:00:00.000Z', bytesUsed: 4000, objectCount: 3 }],
      egress: [{ timestamp: '2026-01-01T00:00:00.000Z', bytesUsed: 1500 }],
      buckets: ['alpha', 'beta'],
      info: { bucketCount: 2, bucketLimit: 50, keyCount: 3, accessKeyLimit: 200 },
    });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);
    stubAccessKeyRows({ createdBy: USER_INFO.userId }, { createdBy: 'user-2' });

    const body = await run();

    expect(body).toStrictEqual({
      storage: { usedBytes: 4000 },
      egress: { usedBytes: 1500 },
      buckets: { count: 2 },
      objects: { count: 3 },
      accessKeys: { count: 2 },
    });
  });

  // FIL-996: the counters sat beside "View all" links while being read from a
  // different source than the pages those links lead to. These two pin the
  // counts to the sources the pages themselves use.
  it('counts buckets from the live listing, not the quota snapshot', async () => {
    const aurora = fakeOrchestrator('aurora', {
      region: S3Region.EuWest1,
      buckets: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'],
      // The snapshot lags a freshly created bucket: this is the "4 total" the
      // dashboard used to print beside a Buckets page listing 5.
      info: { bucketCount: 4, bucketLimit: 100, keyCount: 0, accessKeyLimit: 300 },
    });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const body = await run();

    expect(body.buckets).toEqual({ count: 5 });
  });

  it('counts access keys from stored rows, not the orchestrator key count', async () => {
    const aurora = fakeOrchestrator('aurora', {
      region: S3Region.EuWest1,
      // Includes the system `filone-console` key and any key with no stored row,
      // neither of which the API keys page lists.
      info: { bucketCount: 0, bucketLimit: 100, keyCount: 7, accessKeyLimit: 300 },
    });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);
    stubAccessKeyRows({ createdBy: USER_INFO.userId }, { createdBy: 'user-2' });

    const body = await run();

    expect(body.accessKeys).toEqual({ count: 2 });
  });

  it('counts only the keys a Member may see, matching their API keys page', async () => {
    const aurora = fakeOrchestrator('aurora', { region: S3Region.EuWest1 });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);
    stubAccessKeyRows(
      { createdBy: USER_INFO.userId },
      { createdBy: 'user-2' },
      // Unattributed and recovered rows are `keys.manage_all` only.
      {},
      { createdBy: USER_INFO.userId, recovered: true },
    );

    expect((await run(OrgRole.Member)).accessKeys).toEqual({ count: 1 });
    expect((await run(OrgRole.Owner)).accessKeys).toEqual({ count: 4 });
  });

  it('returns defaults when no region is provisioned', async () => {
    const aurora = fakeOrchestrator('aurora', { region: S3Region.EuWest1, ready: false });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const body = await run();

    expect(body).toStrictEqual({
      storage: { usedBytes: 0 },
      egress: { usedBytes: 0 },
      buckets: { count: 0 },
      objects: { count: 0 },
      accessKeys: { count: 0 },
    });
    expect(aurora.getTenantUsageMetrics).not.toHaveBeenCalled();
    expect(aurora.getTenantInfo).not.toHaveBeenCalled();
    expect(aurora.listBuckets).not.toHaveBeenCalled();
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
      buckets: { count: 0 },
      objects: { count: 0 },
      accessKeys: { count: 0 },
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

  it('sums usage and counts across all provisioned regions', async () => {
    const aurora = fakeOrchestrator('aurora', {
      region: S3Region.EuWest1,
      storage: [{ timestamp: '2026-01-15T00:00:00.000Z', bytesUsed: 1000, objectCount: 5 }],
      egress: [{ timestamp: '2026-01-15T00:00:00.000Z', bytesUsed: 200 }],
      buckets: ['alpha', 'beta'],
      info: { bucketCount: 2, bucketLimit: 100, keyCount: 4, accessKeyLimit: 300 },
    });
    const fth = fakeOrchestrator('fth', {
      region: S3Region.UsEast1,
      storage: [{ timestamp: '2026-01-15T00:00:00.000Z', bytesUsed: 500, objectCount: 1 }],
      egress: [{ timestamp: '2026-01-15T00:00:00.000Z', bytesUsed: 50 }],
      buckets: ['gamma'],
      info: { bucketCount: 1, bucketLimit: 100, keyCount: 2, accessKeyLimit: 300 },
    });
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);
    stubAccessKeyRows(
      { createdBy: USER_INFO.userId },
      { createdBy: 'user-2' },
      { createdBy: 'user-3' },
      { createdBy: 'user-4' },
    );

    const body = await run();

    expect(body.storage.usedBytes).toBe(1500);
    expect(body.objects.count).toBe(6);
    expect(body.egress.usedBytes).toBe(250);
    expect(body.buckets).toEqual({ count: 3 });
    expect(body.accessKeys).toEqual({ count: 4 });

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
      buckets: ['alpha', 'beta'],
      info: { bucketCount: 2, bucketLimit: 100, keyCount: 3, accessKeyLimit: 300 },
    });
    const fth = fakeOrchestrator('fth', { region: S3Region.UsEast1, failUsage: true });
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);
    stubAccessKeyRows({ createdBy: USER_INFO.userId }, { createdBy: 'user-2' });

    const body = await run();

    expect(body.storage.usedBytes).toBe(1000);
    expect(body.buckets).toEqual({ count: 2 });
    // Keys are not region-sourced, so a dead region cannot change their count.
    expect(body.accessKeys).toEqual({ count: 2 });
  });

  it('returns defaults when every provisioned region fails to fetch usage', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const aurora = fakeOrchestrator('aurora', { region: S3Region.EuWest1, failUsage: true });
    const fth = fakeOrchestrator('fth', { region: S3Region.UsEast1, failUsage: true });
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);
    stubAccessKeyRows({ createdBy: USER_INFO.userId }, { createdBy: 'user-2' });

    const result = await baseHandler(authenticatedEvent());
    const body = JSON.parse(String((result as { body: string }).body));

    // No region survives, so every region-sourced figure falls back to zero
    // rather than erroring out. The key count is read from DynamoDB, so it is
    // still the true one.
    expect((result as { statusCode: number }).statusCode).toBe(200);
    expect(body).toStrictEqual({
      storage: { usedBytes: 0 },
      egress: { usedBytes: 0 },
      buckets: { count: 0 },
      objects: { count: 0 },
      accessKeys: { count: 2 },
    });
    // tenantStatus is omitted entirely when no region reports one.
    expect(body).not.toHaveProperty('tenantStatus');
    // Each failed region's error is logged (swallowed, not thrown).
    expect(errorSpy).toHaveBeenCalledTimes(2);

    errorSpy.mockRestore();
  });
});
