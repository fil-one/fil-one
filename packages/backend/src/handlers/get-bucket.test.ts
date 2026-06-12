import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockIsTenantReady = vi.fn();
const mockGetBucket = vi.fn();
const mockGetOrchestratorForRegion = vi.fn();

const mockOrchestrator = {
  id: 'aurora',
  region: 'eu-west-1',
  isTenantReady: (...args: unknown[]) => mockIsTenantReady(...args),
  getBucket: (...args: unknown[]) => mockGetBucket(...args),
};

vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getOrchestratorForRegion: (...args: unknown[]) => mockGetOrchestratorForRegion(...args),
}));

process.env.FILONE_STAGE = 'test';

import { baseHandler } from './get-bucket.js';
import { buildEvent } from '../test/lambda-test-utilities.js';
import { S3_REGION, S3Region } from '@filone/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('get-bucket baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTenantReady.mockResolvedValue('aurora-t-1');
    mockGetOrchestratorForRegion.mockReturnValue(mockOrchestrator);
  });

  it('returns 200 with bucket data from the orchestrator', async () => {
    mockGetBucket.mockResolvedValue({
      bucketName: 'my-bucket',
      region: S3_REGION,
      createdAt: '2026-01-15T10:00:00Z',
      isPublic: false,
      objectLockEnabled: false,
      versioning: false,
      encrypted: true,
    });

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({
      bucket: {
        bucketName: 'my-bucket',
        region: S3_REGION,
        createdAt: '2026-01-15T10:00:00Z',
        isPublic: false,
        objectLockEnabled: false,
        versioning: false,
        encrypted: true,
      },
    });
  });

  it('returns objectLockEnabled true when the orchestrator reports it', async () => {
    mockGetBucket.mockResolvedValue({
      bucketName: 'locked-bucket',
      region: S3_REGION,
      createdAt: '2026-01-15T10:00:00Z',
      isPublic: false,
      objectLockEnabled: true,
      versioning: false,
      encrypted: true,
    });

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'locked-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body!);
    expect(body.bucket.objectLockEnabled).toBe(true);
  });

  it('passes through versioning, encryption, and retention fields', async () => {
    mockGetBucket.mockResolvedValue({
      bucketName: 'full-bucket',
      region: S3_REGION,
      createdAt: '2026-01-15T10:00:00Z',
      isPublic: false,
      objectLockEnabled: true,
      versioning: true,
      encrypted: true,
      defaultRetention: 'compliance',
      retentionDuration: 365,
      retentionDurationType: 'd',
    });

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'full-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({
      bucket: {
        bucketName: 'full-bucket',
        region: S3_REGION,
        createdAt: '2026-01-15T10:00:00Z',
        isPublic: false,
        objectLockEnabled: true,
        versioning: true,
        encrypted: true,
        defaultRetention: 'compliance',
        retentionDuration: 365,
        retentionDurationType: 'd',
      },
    });
  });

  it('calls orchestrator.getBucket with tenantId and bucketName', async () => {
    mockGetBucket.mockResolvedValue({
      bucketName: 'my-bucket',
      region: S3_REGION,
      createdAt: '2026-01-15T10:00:00Z',
      isPublic: false,
      versioning: false,
      encrypted: true,
    });

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    await baseHandler(event);

    expect(mockGetBucket).toHaveBeenCalledWith('aurora-t-1', 'my-bucket');
  });

  it('returns 404 when orchestrator.getBucket returns null', async () => {
    mockGetBucket.mockResolvedValue(null);

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'nonexistent-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(404);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({ message: 'Bucket not found' });
  });

  it('throws when the orchestrator throws', async () => {
    mockGetBucket.mockRejectedValue(
      new Error('Failed to get bucket "my-bucket" from Aurora for tenant aurora-t-1'),
    );

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };

    await expect(baseHandler(event)).rejects.toThrow(
      'Failed to get bucket "my-bucket" from Aurora for tenant aurora-t-1',
    );
  });

  it('returns 400 when bucket name is missing', async () => {
    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({ message: 'Bucket name is required' });
  });

  it('returns 503 when tenant is missing', async () => {
    mockIsTenantReady.mockResolvedValue(null);

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    expect(mockGetBucket).not.toHaveBeenCalled();
  });

  it('uses S3_REGION when region query param is omitted', async () => {
    mockGetBucket.mockResolvedValue({
      bucketName: 'my-bucket',
      region: S3_REGION,
      createdAt: '2026-01-15T10:00:00Z',
      isPublic: false,
      versioning: false,
      encrypted: true,
    });

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    await baseHandler(event);

    expect(mockGetOrchestratorForRegion).toHaveBeenCalledWith(S3_REGION);
  });

  it('selects the orchestrator using the region from the query string', async () => {
    mockGetBucket.mockResolvedValue({
      bucketName: 'my-bucket',
      region: S3Region.UsEast1,
      createdAt: '2026-01-15T10:00:00Z',
      isPublic: false,
      versioning: false,
      encrypted: true,
    });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { region: S3Region.UsEast1 },
    });
    event.pathParameters = { name: 'my-bucket' };
    await baseHandler(event);

    expect(mockGetOrchestratorForRegion).toHaveBeenCalledWith(S3Region.UsEast1);
  });

  it('returns 400 when region is unsupported', async () => {
    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { region: 'us-west-2' },
    });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body!);
    expect(body.message).toContain('Unsupported region');
    expect(mockGetOrchestratorForRegion).not.toHaveBeenCalled();
    expect(mockIsTenantReady).not.toHaveBeenCalled();
    expect(mockGetBucket).not.toHaveBeenCalled();
  });

  it('rejects us-east-1 in production for a non-Foundation user', async () => {
    const previous = process.env.FILONE_STAGE;
    process.env.FILONE_STAGE = 'production';
    try {
      const event = buildEvent({
        userInfo: USER_INFO,
        queryStringParameters: { region: S3Region.UsEast1 },
      });
      event.pathParameters = { name: 'my-bucket' };
      const result = await baseHandler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body!).message).toContain('Unsupported region');
      expect(mockGetOrchestratorForRegion).not.toHaveBeenCalled();
    } finally {
      process.env.FILONE_STAGE = previous;
    }
  });

  it.skip('accepts us-east-1 in production for a verified Foundation email', async () => {
    const previous = process.env.FILONE_STAGE;
    process.env.FILONE_STAGE = 'production';
    mockGetBucket.mockResolvedValue({
      bucketName: 'my-bucket',
      region: S3Region.UsEast1,
      createdAt: '2026-01-15T10:00:00Z',
      isPublic: false,
      versioning: false,
      encrypted: true,
    });
    try {
      const event = buildEvent({
        userInfo: { ...USER_INFO, email: 'dogfood@fil.org', emailVerified: true },
        queryStringParameters: { region: S3Region.UsEast1 },
      });
      event.pathParameters = { name: 'my-bucket' };
      await baseHandler(event);

      expect(mockGetOrchestratorForRegion).toHaveBeenCalledWith(S3Region.UsEast1);
    } finally {
      process.env.FILONE_STAGE = previous;
    }
  });
});
