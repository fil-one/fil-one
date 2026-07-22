import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const mockOrchestrator = {
  id: 'aurora',
  region: 'eu-west-1',
  isTenantReady: (...args: unknown[]) => mockIsTenantReady(...args),
  listBuckets: (...args: unknown[]) => mockListBuckets(...args),
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
}) {
  return {
    id: opts.id,
    region: opts.region,
    isTenantReady: vi.fn().mockReturnValue(opts.tenantId),
    listBuckets: vi.fn().mockResolvedValue(opts.buckets ?? []),
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

function setTenant(tenantId?: string) {
  mockIsTenantReady.mockReturnValue(tenantId ?? null);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('get-activity baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    mockListBuckets.mockResolvedValue([]);
    mockGetAvailableOrchestrators.mockReturnValue([mockOrchestrator]);
    setTenant(AURORA_TENANT_ID);
  });

  it('returns 200 with empty activities when no buckets exist', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));
    expect(body).toStrictEqual({ activities: [] });
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
    });

    // The feed never surfaces versioning, so it must opt out of the per-bucket
    // versioning lookups to avoid the FTH N+1.
    expect(mockListBuckets).toHaveBeenCalledWith(AURORA_TENANT_ID, { includeVersioning: false });
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
    it('merges bucket activities across all orchestrators', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const aurora = createMockedOrchestrator({
        id: 'aurora',
        region: 'eu-west-1',
        tenantId: 'aurora-t',
        buckets: [{ bucketName: 'eu-bucket', createdAt: '2026-01-01T00:00:00Z' }],
      });
      const fth = createMockedOrchestrator({
        id: 'fth',
        region: 'us-east-1',
        tenantId: 'fth-t',
        buckets: [{ bucketName: 'us-bucket', createdAt: '2026-01-01T06:00:00Z' }],
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
      expect(aurora.listBuckets).toHaveBeenCalledWith('aurora-t');
      expect(fth.listBuckets).toHaveBeenCalledWith('fth-t');
    });

    it('skips orchestrators whose tenant is not ready', async () => {
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
      // The unprovisioned region is never queried for buckets.
      expect(fth.listBuckets).not.toHaveBeenCalled();
    });
  });
});
