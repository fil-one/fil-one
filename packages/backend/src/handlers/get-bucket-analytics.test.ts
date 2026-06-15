import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BucketNotFoundError } from '../lib/errors.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockGetOrchestratorForRegion = vi.fn();
vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getOrchestratorForRegion: (...args: unknown[]) => mockGetOrchestratorForRegion(...args),
}));

vi.mock('../lib/org-profile.js', () => ({
  getOrgProfile: vi.fn(async (orgId: string) => ({ pk: { S: `ORG#${orgId}` } })),
}));

interface StorageSample {
  timestamp: string;
  bytesUsed: number;
  objectCount: number;
}

// Builds a fully self-contained fake orchestrator. `tenantId` controls
// isTenantReady; `usageMetrics` is the value getBucketUsageMetrics resolves to
// (or an Error instance to reject with).
function createMockedOrchestrator(opts: {
  id: string;
  region: string;
  tenantId: string | null;
  usageMetrics?: StorageSample[] | Error;
}) {
  const usage = opts.usageMetrics ?? [];
  return {
    id: opts.id,
    region: opts.region,
    isTenantReady: vi.fn().mockReturnValue(opts.tenantId),
    getBucketUsageMetrics:
      usage instanceof Error ? vi.fn().mockRejectedValue(usage) : vi.fn().mockResolvedValue(usage),
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

function authenticatedEvent(bucketName?: string, region?: string) {
  const event = buildEvent({ userInfo: USER_INFO });
  if (bucketName) {
    event.pathParameters = { name: bucketName };
  }
  if (region) {
    event.queryStringParameters = { region };
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

  it('returns analytics from the resolved region', async () => {
    const aurora = createMockedOrchestrator({
      id: 'aurora',
      region: 'eu-west-1',
      tenantId: AURORA_TENANT_ID,
      usageMetrics: [{ timestamp: '2026-01-01T00:00:00.000Z', bytesUsed: 4000, objectCount: 3 }],
    });
    mockGetOrchestratorForRegion.mockReturnValue(aurora);

    const result = await baseHandler(authenticatedEvent('my-bucket', 'eu-west-1'));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toStrictEqual({ objectCount: 3, bytesUsed: 4000 });
    expect(aurora.getBucketUsageMetrics).toHaveBeenCalledWith(
      AURORA_TENANT_ID,
      'my-bucket',
      expect.any(Object),
    );
  });

  it('defaults to eu-west-1 when no region query param is provided', async () => {
    const aurora = createMockedOrchestrator({
      id: 'aurora',
      region: 'eu-west-1',
      tenantId: AURORA_TENANT_ID,
      usageMetrics: [{ timestamp: '2026-01-01T00:00:00.000Z', bytesUsed: 4000, objectCount: 3 }],
    });
    mockGetOrchestratorForRegion.mockReturnValue(aurora);

    const result = await baseHandler(authenticatedEvent('my-bucket'));

    expect(result.statusCode).toBe(200);
    expect(mockGetOrchestratorForRegion).toHaveBeenCalledWith('eu-west-1');
  });

  it('returns zeros when the orchestrator has no samples', async () => {
    const aurora = createMockedOrchestrator({
      id: 'aurora',
      region: 'eu-west-1',
      tenantId: AURORA_TENANT_ID,
      usageMetrics: [],
    });
    mockGetOrchestratorForRegion.mockReturnValue(aurora);

    const result = await baseHandler(authenticatedEvent('my-bucket', 'eu-west-1'));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toStrictEqual({ objectCount: 0, bytesUsed: 0 });
  });

  it('uses the last sample for values', async () => {
    const aurora = createMockedOrchestrator({
      id: 'aurora',
      region: 'eu-west-1',
      tenantId: AURORA_TENANT_ID,
      usageMetrics: [
        { timestamp: '2026-01-01T00:00:00.000Z', bytesUsed: 1000, objectCount: 2 },
        { timestamp: '2026-01-15T00:00:00.000Z', bytesUsed: 5000, objectCount: 8 },
      ],
    });
    mockGetOrchestratorForRegion.mockReturnValue(aurora);

    const result = await baseHandler(authenticatedEvent('my-bucket', 'eu-west-1'));

    expect(JSON.parse(result.body!)).toStrictEqual({ objectCount: 8, bytesUsed: 5000 });
  });

  it('returns 400 when bucket name is missing', async () => {
    const result = await baseHandler(authenticatedEvent(undefined, 'eu-west-1'));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body!)).toStrictEqual({ message: 'Bucket name is required' });
  });

  it('returns 400 for an unsupported region', async () => {
    const result = await baseHandler(authenticatedEvent('my-bucket', 'mars-1'));

    expect(result.statusCode).toBe(400);
    expect(mockGetOrchestratorForRegion).not.toHaveBeenCalled();
  });

  it('returns 503 when the tenant is not ready in the region', async () => {
    const aurora = createMockedOrchestrator({
      id: 'aurora',
      region: 'eu-west-1',
      tenantId: null,
    });
    mockGetOrchestratorForRegion.mockReturnValue(aurora);

    const result = await baseHandler(authenticatedEvent('my-bucket', 'eu-west-1'));

    expect(result.statusCode).toBe(503);
    expect(aurora.getBucketUsageMetrics).not.toHaveBeenCalled();
  });

  it('returns 404 when getBucketUsageMetrics reports the bucket is not found', async () => {
    const aurora = createMockedOrchestrator({
      id: 'aurora',
      region: 'eu-west-1',
      tenantId: AURORA_TENANT_ID,
      usageMetrics: new BucketNotFoundError('other-orgs-bucket'),
    });
    mockGetOrchestratorForRegion.mockReturnValue(aurora);

    const result = await baseHandler(authenticatedEvent('other-orgs-bucket', 'eu-west-1'));

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body!)).toStrictEqual({ message: 'Bucket not found' });
  });

  it('propagates non-not-found errors (becomes a 500 via the middleware)', async () => {
    const aurora = createMockedOrchestrator({
      id: 'aurora',
      region: 'eu-west-1',
      tenantId: AURORA_TENANT_ID,
      usageMetrics: new Error('upstream metrics failure'),
    });
    mockGetOrchestratorForRegion.mockReturnValue(aurora);

    await expect(baseHandler(authenticatedEvent('my-bucket', 'eu-west-1'))).rejects.toThrow(
      'upstream metrics failure',
    );
  });
});
