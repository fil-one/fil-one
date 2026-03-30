import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { ModelStorageMetricsSample } from '../lib/aurora-backoffice.js';
import { FINAL_SETUP_STATUS } from '../lib/org-setup-status.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockGetStorageSamples = vi.fn<() => Promise<ModelStorageMetricsSample[]>>();

vi.mock('../lib/aurora-backoffice.js', () => ({
  getStorageSamples: (...args: unknown[]) => mockGetStorageSamples(...(args as [])),
}));

const mockGetAuroraS3Credentials = vi.fn();
const mockListBuckets = vi.fn();

vi.mock('../lib/aurora-s3-client.js', () => ({
  getAuroraS3Credentials: (...args: unknown[]) => mockGetAuroraS3Credentials(...args),
  listBuckets: (...args: unknown[]) => mockListBuckets(...args),
}));

process.env.FILONE_STAGE = 'test';
process.env.AURORA_S3_GATEWAY_URL = 'https://s3.dev.aur.lu';

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './get-activity.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };
const AURORA_TENANT_ID = 'aurora-tenant-1';

function orgProfileItem(auroraTenantId?: string) {
  return {
    pk: { S: `ORG#${USER_INFO.orgId}` },
    sk: { S: 'PROFILE' },
    ...(auroraTenantId
      ? { auroraTenantId: { S: auroraTenantId }, setupStatus: { S: FINAL_SETUP_STATUS } }
      : {}),
  };
}

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
): ModelStorageMetricsSample {
  return { timestamp, bytesUsed, objectCount };
}

function orgProfileWithTenant() {
  return {
    Item: {
      pk: { S: `ORG#${USER_INFO.orgId}` },
      sk: { S: 'PROFILE' },
      auroraTenantId: { S: 'aurora-t-1' },
      setupStatus: { S: FINAL_SETUP_STATUS },
    },
  };
}

/** Build an array of { date: expect.any(String), value } for flat trend assertions. */
function flatTrend(length: number, value: number) {
  return Array.from({ length }, () => ({ date: expect.any(String), value }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('get-activity baseHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    ddbMock.reset();
    mockGetStorageSamples.mockResolvedValue([]);
    mockGetAuroraS3Credentials.mockResolvedValue({
      accessKeyId: 'AKIA_CONSOLE',
      secretAccessKey: 's3_secret',
    });
    mockListBuckets.mockResolvedValue({ buckets: [] });
    ddbMock.on(GetItemCommand, { TableName: 'UserInfoTable' }).resolves(orgProfileWithTenant());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mockOrgProfile(auroraTenantId?: string) {
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: marshall({ pk: `ORG#${USER_INFO.orgId}`, sk: 'PROFILE' }),
      })
      .resolves({ Item: orgProfileItem(auroraTenantId) });
  }

  it('returns 200 with empty activities and zero-filled trends when no buckets exist', async () => {
    vi.setSystemTime(new Date('2026-01-08T12:00:00Z'));
    mockOrgProfile(AURORA_TENANT_ID);
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

  it('returns trends from Aurora with missing days zero-filled', async () => {
    vi.setSystemTime(new Date('2026-01-05T12:00:00Z'));
    mockOrgProfile(AURORA_TENANT_ID);
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    // Only provide samples for Jan 1 and Jan 3 — gaps on Jan 2, 4, 5
    mockGetStorageSamples.mockResolvedValue([
      storageSample('2025-12-29T00:00:00.000Z', 1000, 5),
      storageSample('2025-12-31T00:00:00.000Z', 2000, 10),
    ]);

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

  it('returns zero-filled trends when auroraTenantId is missing', async () => {
    vi.setSystemTime(new Date('2026-01-08T12:00:00Z'));
    mockOrgProfile(); // no auroraTenantId
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    // Still get a full series of zeroes
    expect(body.trends.storage).toStrictEqual(
      new Array(7).fill({ value: 0, date: expect.any(String) }),
    );
    expect(mockGetStorageSamples).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('fills correct number of entries for 30d period', async () => {
    vi.setSystemTime(new Date('2026-01-31T12:00:00Z'));
    mockOrgProfile(AURORA_TENANT_ID);
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
    vi.useRealTimers();
  });

  it('returns bucket activities without object activities', async () => {
    mockOrgProfile(AURORA_TENANT_ID);

    mockListBuckets.mockResolvedValue({
      buckets: [{ name: 'photos', createdAt: '2026-01-01T00:00:00Z' }],
    });

    // Access keys query
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
    mockOrgProfile(AURORA_TENANT_ID);

    mockListBuckets.mockResolvedValue({
      buckets: [
        { name: 'b1', createdAt: '2026-01-01T00:00:00Z' },
        { name: 'b2', createdAt: '2026-01-02T00:00:00Z' },
        { name: 'b3', createdAt: '2026-01-03T00:00:00Z' },
      ],
    });

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
    mockOrgProfile(AURORA_TENANT_ID);

    mockListBuckets.mockResolvedValue({
      buckets: [{ name: 'b1', createdAt: '2026-01-01T00:00:00Z' }],
    });

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
    mockOrgProfile(AURORA_TENANT_ID);

    mockListBuckets.mockResolvedValue({
      buckets: [{ name: 'b1', createdAt: '2026-01-01T00:00:00Z' }],
    });

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
    mockOrgProfile(AURORA_TENANT_ID);
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

  it('passes correct period to Aurora storage API', async () => {
    mockOrgProfile(AURORA_TENANT_ID);
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { period: '30d' },
    });

    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    expect(mockGetStorageSamples).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: AURORA_TENANT_ID,
        window: '24h',
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
    mockListBuckets.mockResolvedValue({
      buckets: [{ name: 'data', createdAt: '2025-01-01T00:00:00Z' }],
    });

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
    mockOrgProfile(AURORA_TENANT_ID);

    mockListBuckets.mockResolvedValue({
      buckets: [{ name: 'b1', createdAt: '2026-01-01T00:00:00Z' }],
    });

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
    mockOrgProfile(AURORA_TENANT_ID);
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
    mockOrgProfile(AURORA_TENANT_ID);
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
    mockOrgProfile(AURORA_TENANT_ID);
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
});
