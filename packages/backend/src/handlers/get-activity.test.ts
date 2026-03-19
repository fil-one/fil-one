import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { ModelStorageMetricsSample } from '../lib/aurora-backoffice.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UploadsTable: { name: 'UploadsTable' },
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockGetStorageSamples = vi.fn<() => Promise<ModelStorageMetricsSample[]>>();

vi.mock('../lib/aurora-backoffice.js', () => ({
  getStorageSamples: (...args: unknown[]) => mockGetStorageSamples(...(args as [])),
}));

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
    ...(auroraTenantId ? { auroraTenantId: { S: auroraTenantId } } : {}),
  };
}

function bucketItem(name: string, createdAt: string) {
  return marshall({
    pk: `USER#${USER_INFO.userId}`,
    sk: `BUCKET#${name}`,
    name,
    region: 'us-east-1',
    createdAt,
    isPublic: false,
  });
}

function objectItem(bucketName: string, key: string, uploadedAt: string, sizeBytes: number) {
  return marshall({
    pk: `BUCKET#${USER_INFO.userId}#${bucketName}`,
    sk: `OBJECT#${key}`,
    key,
    fileName: key,
    contentType: 'application/octet-stream',
    sizeBytes,
    uploadedAt,
    etag: '"abc"',
    s3Key: `${bucketName}/${key}`,
  });
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('get-activity baseHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    ddbMock.reset();
    mockGetStorageSamples.mockResolvedValue([]);
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
    // Default period is 7d → 8 entries (from Jan 1 through Jan 8)
    expect(body.trends.storage.length).toBe(8);
    expect(body.trends.storage.every((p: { value: number }) => p.value === 0)).toBe(true);
    expect(body.trends.objects.length).toBe(8);
    expect(body.trends.objects.every((p: { value: number }) => p.value === 0)).toBe(true);
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

    // 7-day period from Dec 29 through Jan 5 = 8 entries
    expect(body.trends.storage.length).toBe(8);
    expect(body.trends.storage[0]).toStrictEqual({ date: '2025-12-29T23:59:59.999Z', value: 1000 });
    expect(body.trends.storage[1]).toStrictEqual({ date: '2025-12-30T23:59:59.999Z', value: 0 });
    expect(body.trends.storage[2]).toStrictEqual({ date: '2025-12-31T23:59:59.999Z', value: 2000 });
    expect(body.trends.storage[3]).toStrictEqual({ date: '2026-01-01T23:59:59.999Z', value: 0 });

    expect(body.trends.objects[0]).toStrictEqual({ date: '2025-12-29T23:59:59.999Z', value: 5 });
    expect(body.trends.objects[2]).toStrictEqual({ date: '2025-12-31T23:59:59.999Z', value: 10 });
    expect(body.trends.objects[3]).toStrictEqual({ date: '2026-01-01T23:59:59.999Z', value: 0 });
  });

  it('returns zero-filled trends when auroraTenantId is missing', async () => {
    vi.setSystemTime(new Date('2026-01-08T12:00:00Z'));
    mockOrgProfile(); // no auroraTenantId
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    // Still get a full series of zeroes
    expect(body.trends.storage.length).toBe(8);
    expect(body.trends.storage.every((p: { value: number }) => p.value === 0)).toBe(true);
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

    // 30-day period from Jan 1 through Jan 31 = 31 entries
    expect(body.trends.storage).toHaveLength(31);
    expect(body.trends.objects).toHaveLength(31);
    // First entry should be Jan 1 end-of-day UTC
    expect(body.trends.storage[0].date).toBe('2026-01-01T23:59:59.999Z');
    vi.useRealTimers();
  });

  it('returns bucket and object activities sorted most-recent-first', async () => {
    mockOrgProfile(AURORA_TENANT_ID);

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `USER#${USER_INFO.userId}` } },
      })
      .resolves({
        Items: [bucketItem('photos', '2026-01-01T00:00:00Z')],
      });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: {
          ':pk': { S: `BUCKET#${USER_INFO.userId}#photos` },
          ':skPrefix': { S: 'OBJECT#' },
        },
      })
      .resolves({
        Items: [
          objectItem('photos', 'cat.jpg', '2026-01-05T00:00:00Z', 1024),
          objectItem('photos', 'dog.jpg', '2026-01-03T00:00:00Z', 2048),
        ],
      });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `ORG#${USER_INFO.orgId}` } },
      })
      .resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));

    expect(body.activities).toStrictEqual([
      {
        id: 'object-photos-cat.jpg',
        action: 'object.uploaded',
        resourceType: 'object',
        resourceName: 'cat.jpg',
        timestamp: '2026-01-05T00:00:00Z',
        sizeBytes: 1024,
      },
      {
        id: 'object-photos-dog.jpg',
        action: 'object.uploaded',
        resourceType: 'object',
        resourceName: 'dog.jpg',
        timestamp: '2026-01-03T00:00:00Z',
        sizeBytes: 2048,
      },
      {
        id: 'bucket-photos',
        action: 'bucket.created',
        resourceType: 'bucket',
        resourceName: 'photos',
        timestamp: '2026-01-01T00:00:00Z',
      },
    ]);
  });

  it('respects the limit query parameter', async () => {
    mockOrgProfile(AURORA_TENANT_ID);

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `USER#${USER_INFO.userId}` } },
      })
      .resolves({
        Items: [bucketItem('b1', '2026-01-01T00:00:00Z')],
      });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: {
          ':pk': { S: `BUCKET#${USER_INFO.userId}#b1` },
          ':skPrefix': { S: 'OBJECT#' },
        },
      })
      .resolves({
        Items: [
          objectItem('b1', 'a.txt', '2026-01-02T00:00:00Z', 100),
          objectItem('b1', 'b.txt', '2026-01-03T00:00:00Z', 200),
          objectItem('b1', 'c.txt', '2026-01-04T00:00:00Z', 300),
        ],
      });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `ORG#${USER_INFO.orgId}` } },
      })
      .resolves({ Items: [] });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { limit: '2' },
    });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    expect(body.activities).toHaveLength(2);
    expect(body.activities[0].resourceName).toBe('c.txt');
    expect(body.activities[1].resourceName).toBe('b.txt');
  });

  it('defaults limit to 10 when limit is non-numeric', async () => {
    mockOrgProfile(AURORA_TENANT_ID);

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `USER#${USER_INFO.userId}` } },
      })
      .resolves({
        Items: [bucketItem('b1', '2026-01-01T00:00:00Z')],
      });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: {
          ':pk': { S: `BUCKET#${USER_INFO.userId}#b1` },
          ':skPrefix': { S: 'OBJECT#' },
        },
      })
      .resolves({
        Items: [
          objectItem('b1', 'a.txt', '2026-01-02T00:00:00Z', 100),
          objectItem('b1', 'b.txt', '2026-01-03T00:00:00Z', 200),
        ],
      });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `ORG#${USER_INFO.orgId}` } },
      })
      .resolves({ Items: [] });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { limit: 'abc' },
    });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    // Should fall back to 10, not return empty due to NaN
    expect(body.activities).toHaveLength(3);
  });

  it('defaults limit to 10 when limit is negative', async () => {
    mockOrgProfile(AURORA_TENANT_ID);

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `USER#${USER_INFO.userId}` } },
      })
      .resolves({
        Items: [bucketItem('b1', '2026-01-01T00:00:00Z')],
      });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: {
          ':pk': { S: `BUCKET#${USER_INFO.userId}#b1` },
          ':skPrefix': { S: 'OBJECT#' },
        },
      })
      .resolves({
        Items: [
          objectItem('b1', 'a.txt', '2026-01-02T00:00:00Z', 100),
          objectItem('b1', 'b.txt', '2026-01-03T00:00:00Z', 200),
        ],
      });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `ORG#${USER_INFO.orgId}` } },
      })
      .resolves({ Items: [] });

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
    await baseHandler(event);

    expect(mockGetStorageSamples).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: AURORA_TENANT_ID,
        window: '24h',
      }),
    );

    // Verify the from date is ~30 days before to
    const call = mockGetStorageSamples.mock.calls[0] as unknown as [{ from: string; to: string }];
    const { from: fromStr, to: toStr } = call[0];
    const fromDate = new Date(fromStr);
    const toDate = new Date(toStr);
    const diffDays = (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(29);
    expect(diffDays).toBeLessThanOrEqual(31);
  });

  it('includes key activities sorted with buckets and objects', async () => {
    mockOrgProfile(AURORA_TENANT_ID);

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `USER#${USER_INFO.userId}` } },
      })
      .resolves({
        Items: [bucketItem('b1', '2026-01-01T00:00:00Z')],
      });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: {
          ':pk': { S: `BUCKET#${USER_INFO.userId}#b1` },
          ':skPrefix': { S: 'OBJECT#' },
        },
      })
      .resolves({ Items: [] });

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

  it('includes sizeBytes and cid on object activities when present', async () => {
    mockOrgProfile(AURORA_TENANT_ID);

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `USER#${USER_INFO.userId}` } },
      })
      .resolves({
        Items: [bucketItem('b1', '2026-01-01T00:00:00Z')],
      });

    const objWithCid = marshall({
      pk: `BUCKET#${USER_INFO.userId}#b1`,
      sk: 'OBJECT#file.dat',
      key: 'file.dat',
      fileName: 'file.dat',
      contentType: 'application/octet-stream',
      sizeBytes: 4096,
      uploadedAt: '2026-01-02T00:00:00Z',
      etag: '"xyz"',
      s3Key: 'b1/file.dat',
      cid: 'bafy123',
    });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: {
          ':pk': { S: `BUCKET#${USER_INFO.userId}#b1` },
          ':skPrefix': { S: 'OBJECT#' },
        },
      })
      .resolves({ Items: [objWithCid] });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `ORG#${USER_INFO.orgId}` } },
      })
      .resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    expect(body.activities).toStrictEqual([
      {
        id: 'object-b1-file.dat',
        action: 'object.uploaded',
        resourceType: 'object',
        resourceName: 'file.dat',
        timestamp: '2026-01-02T00:00:00Z',
        sizeBytes: 4096,
        cid: 'bafy123',
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
});
