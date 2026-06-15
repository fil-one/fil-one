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
  getOrgProfile: vi.fn(async (orgId: string) => ({ pk: { S: `ORG#${orgId}` } })),
}));

interface StorageSample {
  timestamp: string;
  bytesUsed: number;
  objectCount: number;
}

// Builds a fully self-contained fake orchestrator. `ownsBucket` controls whether
// getBucket resolves a record (i.e. the bucket lives in this region).
function createMockedOrchestrator(opts: {
  id: string;
  region: string;
  tenantId: string | null;
  ownsBucket?: boolean;
  samples?: StorageSample[];
}) {
  return {
    id: opts.id,
    region: opts.region,
    isTenantReady: vi.fn().mockReturnValue(opts.tenantId),
    getBucket: vi
      .fn()
      .mockResolvedValue(opts.ownsBucket ? { bucketName: 'my-bucket', region: opts.region } : null),
    getBucketUsageMetrics: vi.fn().mockResolvedValue(opts.samples ?? []),
  };
}

process.env.FILONE_STAGE = 'test';

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './get-bucket-analytics.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1', email: 'user@example.com' };
const AURORA_TENANT_ID = 'aurora-tenant-1';
const FTH_TENANT_ID = 'fth-tenant-1';

function authenticatedEvent(bucketName?: string) {
  const event = buildEvent({ userInfo: USER_INFO });
  if (bucketName) {
    event.pathParameters = { name: bucketName };
  }
  return event;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('get-bucket-analytics baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('returns analytics from the owning orchestrator', async () => {
    const aurora = createMockedOrchestrator({
      id: 'aurora',
      region: 'eu-west-1',
      tenantId: AURORA_TENANT_ID,
      ownsBucket: true,
      samples: [{ timestamp: '2026-01-01T00:00:00.000Z', bytesUsed: 4000, objectCount: 3 }],
    });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const result = await baseHandler(authenticatedEvent('my-bucket'));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toStrictEqual({ objectCount: 3, bytesUsed: 4000 });
    expect(aurora.getBucketUsageMetrics).toHaveBeenCalledWith(
      AURORA_TENANT_ID,
      'my-bucket',
      expect.any(Object),
    );
  });

  it('returns zeros when the owning orchestrator has no samples', async () => {
    const aurora = createMockedOrchestrator({
      id: 'aurora',
      region: 'eu-west-1',
      tenantId: AURORA_TENANT_ID,
      ownsBucket: true,
      samples: [],
    });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const result = await baseHandler(authenticatedEvent('my-bucket'));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toStrictEqual({ objectCount: 0, bytesUsed: 0 });
  });

  it('uses the last sample for values', async () => {
    const aurora = createMockedOrchestrator({
      id: 'aurora',
      region: 'eu-west-1',
      tenantId: AURORA_TENANT_ID,
      ownsBucket: true,
      samples: [
        { timestamp: '2026-01-01T00:00:00.000Z', bytesUsed: 1000, objectCount: 2 },
        { timestamp: '2026-01-15T00:00:00.000Z', bytesUsed: 5000, objectCount: 8 },
      ],
    });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const result = await baseHandler(authenticatedEvent('my-bucket'));

    expect(JSON.parse(result.body!)).toStrictEqual({ objectCount: 8, bytesUsed: 5000 });
  });

  it('resolves a bucket owned by the FTH region', async () => {
    const aurora = createMockedOrchestrator({
      id: 'aurora',
      region: 'eu-west-1',
      tenantId: AURORA_TENANT_ID,
      ownsBucket: false,
    });
    const fth = createMockedOrchestrator({
      id: 'fth',
      region: 'us-east-1',
      tenantId: FTH_TENANT_ID,
      ownsBucket: true,
      samples: [{ timestamp: '2026-01-15T00:00:00.000Z', bytesUsed: 700, objectCount: 4 }],
    });
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

    const result = await baseHandler(authenticatedEvent('my-bucket'));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toStrictEqual({ objectCount: 4, bytesUsed: 700 });
    // Ownership is probed on every region; only the owner fetches metrics.
    expect(aurora.getBucket).toHaveBeenCalled();
    expect(fth.getBucket).toHaveBeenCalled();
    expect(aurora.getBucketUsageMetrics).not.toHaveBeenCalled();
    expect(fth.getBucketUsageMetrics).toHaveBeenCalledWith(
      FTH_TENANT_ID,
      'my-bucket',
      expect.any(Object),
    );
  });

  it('returns 400 when bucket name is missing', async () => {
    mockGetAvailableOrchestrators.mockReturnValue([]);

    const result = await baseHandler(authenticatedEvent());

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body!)).toStrictEqual({ message: 'Bucket name is required' });
  });

  it('returns 503 when no region is provisioned', async () => {
    const aurora = createMockedOrchestrator({
      id: 'aurora',
      region: 'eu-west-1',
      tenantId: null,
    });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const result = await baseHandler(authenticatedEvent('my-bucket'));

    expect(result.statusCode).toBe(503);
    expect(aurora.getBucketUsageMetrics).not.toHaveBeenCalled();
  });

  it('returns 404 when no region owns the bucket', async () => {
    const aurora = createMockedOrchestrator({
      id: 'aurora',
      region: 'eu-west-1',
      tenantId: AURORA_TENANT_ID,
      ownsBucket: false,
    });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const result = await baseHandler(authenticatedEvent('other-orgs-bucket'));

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body!)).toStrictEqual({ message: 'Bucket not found' });
    expect(aurora.getBucketUsageMetrics).not.toHaveBeenCalled();
  });
});
