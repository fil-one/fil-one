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
  getOrgProfile: vi.fn(async (orgId: string) => fakeOrgProfile(orgId)),
}));

process.env.FILONE_STAGE = 'test';

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './get-bucket-analytics.js';
import { buildEvent } from '../test/lambda-test-utilities.js';
import { fakeOrchestrator, fakeOrgProfile, tenantFor } from '../test/fake-orchestrator.js';
import { S3Region } from '@filone/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1', email: 'user@example.com' };
// fakeOrchestrator derives the tenant id from the orgId in the PROFILE item.
const AURORA_TENANT_ID = tenantFor('aurora', USER_INFO.orgId);

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
    const aurora = fakeOrchestrator('aurora', {
      region: S3Region.EuWest1,
      bucketMetrics: [{ timestamp: '2026-01-01T00:00:00.000Z', bytesUsed: 4000, objectCount: 3 }],
    });
    mockGetOrchestratorForRegion.mockReturnValue(aurora);

    const result = await baseHandler(authenticatedEvent('my-bucket', S3Region.EuWest1));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toStrictEqual({ objectCount: 3, bytesUsed: 4000 });
    expect(aurora.getBucketUsageMetrics).toHaveBeenCalledWith(
      AURORA_TENANT_ID,
      'my-bucket',
      expect.any(Object),
    );
  });

  it('defaults to eu-west-1 when no region query param is provided', async () => {
    const aurora = fakeOrchestrator('aurora', {
      region: S3Region.EuWest1,
      bucketMetrics: [{ timestamp: '2026-01-01T00:00:00.000Z', bytesUsed: 4000, objectCount: 3 }],
    });
    mockGetOrchestratorForRegion.mockReturnValue(aurora);

    const result = await baseHandler(authenticatedEvent('my-bucket'));

    expect(result.statusCode).toBe(200);
    expect(mockGetOrchestratorForRegion).toHaveBeenCalledWith(S3Region.EuWest1);
  });

  it('returns zeros when the orchestrator has no samples', async () => {
    const aurora = fakeOrchestrator('aurora', {
      region: S3Region.EuWest1,
      bucketMetrics: [],
    });
    mockGetOrchestratorForRegion.mockReturnValue(aurora);

    const result = await baseHandler(authenticatedEvent('my-bucket', S3Region.EuWest1));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toStrictEqual({ objectCount: 0, bytesUsed: 0 });
  });

  it('uses the last sample for values', async () => {
    const aurora = fakeOrchestrator('aurora', {
      region: S3Region.EuWest1,
      bucketMetrics: [
        { timestamp: '2026-01-01T00:00:00.000Z', bytesUsed: 1000, objectCount: 2 },
        { timestamp: '2026-01-15T00:00:00.000Z', bytesUsed: 5000, objectCount: 8 },
      ],
    });
    mockGetOrchestratorForRegion.mockReturnValue(aurora);

    const result = await baseHandler(authenticatedEvent('my-bucket', S3Region.EuWest1));

    expect(JSON.parse(result.body!)).toStrictEqual({ objectCount: 8, bytesUsed: 5000 });
  });

  it('returns 400 when bucket name is missing', async () => {
    const result = await baseHandler(authenticatedEvent(undefined, S3Region.EuWest1));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body!)).toStrictEqual({ message: 'Bucket name is required' });
  });

  it('returns 400 for an unsupported region', async () => {
    const result = await baseHandler(authenticatedEvent('my-bucket', 'mars-1'));

    expect(result.statusCode).toBe(400);
    expect(mockGetOrchestratorForRegion).not.toHaveBeenCalled();
  });

  it('returns 503 when the tenant is not ready in the region', async () => {
    const aurora = fakeOrchestrator('aurora', { region: S3Region.EuWest1, ready: false });
    mockGetOrchestratorForRegion.mockReturnValue(aurora);

    const result = await baseHandler(authenticatedEvent('my-bucket', S3Region.EuWest1));

    expect(result.statusCode).toBe(503);
    expect(aurora.getBucketUsageMetrics).not.toHaveBeenCalled();
  });

  it('returns 404 when getBucketUsageMetrics reports the bucket is not found', async () => {
    const aurora = fakeOrchestrator('aurora', {
      region: S3Region.EuWest1,
      bucketMetrics: new BucketNotFoundError('other-orgs-bucket'),
    });
    mockGetOrchestratorForRegion.mockReturnValue(aurora);

    const result = await baseHandler(authenticatedEvent('other-orgs-bucket', S3Region.EuWest1));

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body!)).toStrictEqual({ message: 'Bucket not found' });
  });

  it('propagates non-not-found errors (becomes a 500 via the middleware)', async () => {
    const aurora = fakeOrchestrator('aurora', {
      region: S3Region.EuWest1,
      bucketMetrics: new Error('upstream metrics failure'),
    });
    mockGetOrchestratorForRegion.mockReturnValue(aurora);

    await expect(baseHandler(authenticatedEvent('my-bucket', S3Region.EuWest1))).rejects.toThrow(
      'upstream metrics failure',
    );
  });
});
