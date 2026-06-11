import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockIsTenantReady = vi.fn();
const mockListBuckets = vi.fn();
const mockGetTenantUsageMetrics = vi.fn();

const mockOrchestrator = {
  id: 'aurora',
  region: 'eu-west-1',
  isTenantReady: (...args: unknown[]) => mockIsTenantReady(...args),
  listBuckets: (...args: unknown[]) => mockListBuckets(...args),
  getTenantUsageMetrics: (...args: unknown[]) => mockGetTenantUsageMetrics(...args),
};

const mockGetAvailableOrchestrators = vi.fn();
vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getAvailableOrchestrators: (...args: unknown[]) => mockGetAvailableOrchestrators(...args),
}));

vi.mock('../lib/org-profile.js', () => ({
  getOrgProfile: vi.fn(async (orgId: string) => ({ pk: { S: `ORG#${orgId}` } })),
}));

// Builds a fully self-contained fake orchestrator for multi-region tests.
function createMockedOrchestrator(opts: {
  id: string;
  region: string;
  tenantId: string | null;
  buckets?: { bucketName: string; createdAt: string }[];
  storage?: { timestamp: string; bytesUsed: number; objectCount: number }[];
}) {
  return {
    id: opts.id,
    region: opts.region,
    isTenantReady: vi.fn().mockReturnValue(opts.tenantId),
    listBuckets: vi.fn().mockResolvedValue(opts.buckets ?? []),
    getTenantUsageMetrics: vi.fn().mockResolvedValue({ storage: opts.storage ?? [], egress: [] }),
  };
}

process.env.FILONE_STAGE = 'test';

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './get-activity.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };
const AURORA_TENANT_ID = 'aurora-tenant-1';

function keyItem(id: string, keyName: string, createdAt: string) {
  return marshall({
    pk: `ORG#${USER_INFO.orgId}`,
    sk: `ACCESSKEY#${id}`,
    keyName,
    accessKeyId: `AKIA-${id}`,
    createdAt,
    status: 'active',
  });
}

function storageSample(
  timestamp: string,
  bytesUsed: number,
  objectCount: number,
): { timestamp: string; bytesUsed: number; objectCount: number } {
  return { timestamp, bytesUsed, objectCount };
}

function flatTrend(length: number, value: number) {
  return Array.from({ length }, () => ({ date: expect.any(String), value }));
}

function setTenant(tenantId?: string) {
  mockIsTenantReady.mockReturnValue(tenantId ?? null);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('get-activity baseHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    ddbMock.reset();
    mockGetTenantUsageMetrics.mockResolvedValue({ storage: [], egress: [] });
    mockListBuckets.mockResolvedValue([]);
    mockGetAvailableOrchestrators.mockReturnValue([mockOrchestrator]);
    setTenant(AURORA_TENANT_ID);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 200 with empty activities and zero-filled trends when no buckets exist', async () => {
    vi.setSystemTime(new Date('2026-01-08T12:00:00Z'));
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));
    expect(body.activities).toStrictEqual([]);
    // Default period is 7d → 7 entries (from Jan 2 through Jan 8)
    expect(body.trends.storage).toStrictEqual(
      new Array(7).fill({ value: 0, date: expect.any(String) }),
    );
    expect(body.trends.objects).toStrictEqual(
      new Array(7).fill({ value: 0, date: expect.any(String) }),
    );
  });

  it('returns trends with missing days zero-filled', async () => {
    vi.setSystemTime(new Date('2026-01-05T12:00:00Z'));
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    // Only provide samples for Jan 1 and Jan 3 — gaps on Jan 2, 4, 5
    mockGetTenantUsageMetrics.mockResolvedValue({
      storage: [
        storageSample('2025-12-29T00:00:00.000Z', 1000, 5),
        storageSample('2025-12-31T00:00:00.000Z', 2000, 10),
      ],
      egress: [],
    });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));
    // 7-day period from Dec 30 through Jan 5 = 7 entries
    expect(body.trends.storage).toHaveLength(7);
    expect(body.trends.storage[0]).toStrictEqual({ date: '2025-12-30T23:59:59.999Z', value: 0 });
    expect(body.trends.storage[1]).toStrictEqual({ date: '2025-12-31T23:59:59.999Z', value: 2000 });
    expect(body.trends.storage[2]).toStrictEqual({ date: '2026-01-01T23:59:59.999Z', value: 0 });

    expect(body.trends.objects[0]).toStrictEqual({ date: '2025-12-30T23:59:59.999Z', value: 0 });
    expect(body.trends.objects[1]).toStrictEqual({ date: '2025-12-31T23:59:59.999Z', value: 10 });
    expect(body.trends.objects[2]).toStrictEqual({ date: '2026-01-01T23:59:59.999Z', value: 0 });
  });

  it('picks the latest intra-day reading regardless of sample order', async () => {
    vi.setSystemTime(new Date('2026-01-05T12:00:00Z'));
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    // Same UTC day, delivered out of chronological order. The 22:00 reading is
    // the day's latest and must win even though it is not last in the array.
    mockGetTenantUsageMetrics.mockResolvedValue({
      storage: [
        storageSample('2026-01-03T22:00:00.000Z', 3000, 30),
        storageSample('2026-01-03T08:00:00.000Z', 1000, 10),
        storageSample('2026-01-03T15:00:00.000Z', 2000, 20),
      ],
      egress: [],
    });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    const latest = '2026-01-03T23:59:59.999Z';
    expect(body.trends.storage.find((p: { date: string }) => p.date === latest).value).toBe(3000);
    expect(body.trends.objects.find((p: { date: string }) => p.date === latest).value).toBe(30);
  });

  it('returns zero-filled trends when tenant is not ready', async () => {
    vi.setSystemTime(new Date('2026-01-08T12:00:00Z'));
    setTenant(undefined);
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    // Still get a full series of zeroes
    expect(body.trends.storage).toStrictEqual(
      new Array(7).fill({ value: 0, date: expect.any(String) }),
    );
    expect(mockGetTenantUsageMetrics).not.toHaveBeenCalled();
  });

  it('fills correct number of entries for 30d period', async () => {
    vi.setSystemTime(new Date('2026-01-31T12:00:00Z'));
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { period: '30d' },
    });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    // 30-day period from Jan 2 through Jan 31 = 30 entries
    expect(body.trends.storage).toHaveLength(30);
    expect(body.trends.objects).toHaveLength(30);
    // First entry should be Jan 2 end-of-day UTC
    expect(body.trends.storage[0].date).toBe('2026-01-02T23:59:59.999Z');
  });

  it('returns bucket activities without object activities', async () => {
    mockListBuckets.mockResolvedValue([
      { bucketName: 'photos', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));

    expect(body).toStrictEqual({
      activities: [
        {
          id: 'bucket-photos',
          action: 'bucket.created',
          resourceType: 'bucket',
          resourceName: 'photos',
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
      trends: {
        storage: flatTrend(7, expect.any(Number)),
        objects: flatTrend(7, expect.any(Number)),
      },
    });
  });

  it('respects the limit query parameter', async () => {
    mockListBuckets.mockResolvedValue([
      { bucketName: 'b1', createdAt: '2026-01-01T00:00:00Z' },
      { bucketName: 'b2', createdAt: '2026-01-02T00:00:00Z' },
      { bucketName: 'b3', createdAt: '2026-01-03T00:00:00Z' },
    ]);
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { limit: '2' },
    });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    expect(body).toStrictEqual({
      activities: [
        {
          id: 'bucket-b3',
          action: 'bucket.created',
          resourceType: 'bucket',
          resourceName: 'b3',
          timestamp: '2026-01-03T00:00:00Z',
        },
        {
          id: 'bucket-b2',
          action: 'bucket.created',
          resourceType: 'bucket',
          resourceName: 'b2',
          timestamp: '2026-01-02T00:00:00Z',
        },
      ],
      trends: {
        storage: flatTrend(7, expect.any(Number)),
        objects: flatTrend(7, expect.any(Number)),
      },
    });
  });

  it('defaults limit to 10 when limit is non-numeric', async () => {
    mockListBuckets.mockResolvedValue([{ bucketName: 'b1', createdAt: '2026-01-01T00:00:00Z' }]);
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { limit: 'abc' },
    });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));
    // Should fall back to 10, not return empty due to NaN
    expect(body.activities).toHaveLength(1);
  });

  it('defaults limit to 10 when limit is negative', async () => {
    mockListBuckets.mockResolvedValue([{ bucketName: 'b1', createdAt: '2026-01-01T00:00:00Z' }]);
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { limit: '-5' },
    });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    expect(body.activities.length).toBeGreaterThanOrEqual(1);
  });

  it('caps limit at 50', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { limit: '999' },
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));
    expect(body.activities).toStrictEqual([]);
  });

  it('passes correct period to orchestrator usage metrics', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { period: '30d' },
    });

    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    expect(mockGetTenantUsageMetrics).toHaveBeenCalledWith(
      AURORA_TENANT_ID,
      expect.objectContaining({
        interval: '1d',
      }),
    );

    expect(body).toStrictEqual({
      activities: [],
      trends: {
        storage: flatTrend(30, 0),
        objects: flatTrend(30, 0),
      },
    });
  });

  it('defaults to 7-day trend series', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    expect(body).toStrictEqual({
      activities: [],
      trends: {
        storage: flatTrend(7, 0),
        objects: flatTrend(7, 0),
      },
    });
  });

  it('returns only bucket activity (no object activities)', async () => {
    mockListBuckets.mockResolvedValue([{ bucketName: 'data', createdAt: '2025-01-01T00:00:00Z' }]);
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    expect(body).toStrictEqual({
      activities: [
        {
          id: 'bucket-data',
          action: 'bucket.created',
          resourceType: 'bucket',
          resourceName: 'data',
          timestamp: '2025-01-01T00:00:00Z',
        },
      ],
      trends: {
        storage: flatTrend(7, expect.any(Number)),
        objects: flatTrend(7, expect.any(Number)),
      },
    });
  });

  it('includes key activities sorted with buckets and objects', async () => {
    mockListBuckets.mockResolvedValue([{ bucketName: 'b1', createdAt: '2026-01-01T00:00:00Z' }]);

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: {
          ':pk': { S: `ORG#${USER_INFO.orgId}` },
          ':skPrefix': { S: 'ACCESSKEY#' },
        },
      })
      .resolves({
        Items: [keyItem('key-1', 'my-api-key', '2026-01-02T00:00:00Z')],
      });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    expect(body.activities).toStrictEqual([
      {
        id: 'key-key-1',
        action: 'key.created',
        resourceType: 'key',
        resourceName: 'my-api-key',
        timestamp: '2026-01-02T00:00:00Z',
      },
      {
        id: 'bucket-b1',
        action: 'bucket.created',
        resourceType: 'bucket',
        resourceName: 'b1',
        timestamp: '2026-01-01T00:00:00Z',
      },
    ]);
  });

  it('returns 200 with empty buckets when listBuckets throws AccessDenied', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const err = new Error('Access Denied.');
    err.name = 'AccessDenied';
    mockListBuckets.mockRejectedValue(err);

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));
    expect(body.activities).toStrictEqual([]);
  });

  it('returns 200 with empty buckets when listBuckets throws AccessDenied via Code fallback', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const err = new Error('Access Denied.');
    Object.assign(err, { Code: 'AccessDenied' });
    mockListBuckets.mockRejectedValue(err);

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));
    expect(body.activities).toStrictEqual([]);
  });

  it('returns 200 with empty buckets when listBuckets throws a non-AccessDenied error', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    mockListBuckets.mockRejectedValue(new Error('network timeout'));

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));
    expect(body.activities).toStrictEqual([]);
  });
  // Object activities are temporarily excluded from the feed.
  // https://linear.app/filecoin-foundation/issue/FIL-77/object-sealing-live-updates-dashboard

  describe('multi-region aggregation', () => {
    it('merges bucket activities and sums storage trends across all orchestrators', async () => {
      vi.setSystemTime(new Date('2026-01-02T12:00:00Z'));
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const aurora = createMockedOrchestrator({
        id: 'aurora',
        region: 'eu-west-1',
        tenantId: 'aurora-t',
        buckets: [{ bucketName: 'eu-bucket', createdAt: '2026-01-01T00:00:00Z' }],
        storage: [storageSample('2026-01-01T10:00:00.000Z', 1000, 5)],
      });
      const fth = createMockedOrchestrator({
        id: 'fth',
        region: 'us-east-1',
        tenantId: 'fth-t',
        buckets: [{ bucketName: 'us-bucket', createdAt: '2026-01-01T06:00:00Z' }],
        storage: [storageSample('2026-01-01T11:00:00.000Z', 500, 0)],
      });
      mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

      const event = buildEvent({ userInfo: USER_INFO });
      const result = await baseHandler(event);
      const body = JSON.parse(String(result.body));

      // Bucket activities from both regions appear.
      expect(body.activities.map((a: { resourceName: string }) => a.resourceName).sort()).toEqual([
        'eu-bucket',
        'us-bucket',
      ]);

      // Jan 1 storage is summed across regions: 1000 + 500 = 1500; objects: 5 + 0 = 5.
      const jan1 = '2026-01-01T23:59:59.999Z';
      expect(body.trends.storage.find((p: { date: string }) => p.date === jan1).value).toBe(1500);
      expect(body.trends.objects.find((p: { date: string }) => p.date === jan1).value).toBe(5);

      expect(aurora.getTenantUsageMetrics).toHaveBeenCalledWith('aurora-t', expect.any(Object));
      expect(fth.getTenantUsageMetrics).toHaveBeenCalledWith('fth-t', expect.any(Object));
    });

    it('skips orchestrators whose tenant is not ready', async () => {
      vi.setSystemTime(new Date('2026-01-02T12:00:00Z'));
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const aurora = createMockedOrchestrator({
        id: 'aurora',
        region: 'eu-west-1',
        tenantId: 'aurora-t',
        buckets: [{ bucketName: 'eu-bucket', createdAt: '2026-01-01T00:00:00Z' }],
      });
      const fth = createMockedOrchestrator({ id: 'fth', region: 'us-east-1', tenantId: null });
      mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

      const event = buildEvent({ userInfo: USER_INFO });
      const result = await baseHandler(event);
      const body = JSON.parse(String(result.body));

      expect(body.activities.map((a: { resourceName: string }) => a.resourceName)).toEqual([
        'eu-bucket',
      ]);
      // The unprovisioned region is never queried for buckets or usage.
      expect(fth.listBuckets).not.toHaveBeenCalled();
      expect(fth.getTenantUsageMetrics).not.toHaveBeenCalled();
    });

    it('still renders other regions when one orchestrator usage fetch fails', async () => {
      vi.setSystemTime(new Date('2026-01-02T12:00:00Z'));
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const aurora = createMockedOrchestrator({
        id: 'aurora',
        region: 'eu-west-1',
        tenantId: 'aurora-t',
        storage: [storageSample('2026-01-01T10:00:00.000Z', 2000, 3)],
      });
      const fth = createMockedOrchestrator({ id: 'fth', region: 'us-east-1', tenantId: 'fth-t' });
      fth.getTenantUsageMetrics.mockRejectedValue(new Error('FTH metrics down'));
      mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

      const event = buildEvent({ userInfo: USER_INFO });
      const result = await baseHandler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(String(result.body));
      const jan1 = '2026-01-01T23:59:59.999Z';
      expect(body.trends.storage.find((p: { date: string }) => p.date === jan1).value).toBe(2000);
    });
  });
});
