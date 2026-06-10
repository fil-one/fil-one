import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockEnsureTenantReady = vi.fn();
const mockCreateBucket = vi.fn();
const mockGetOrchestratorForRegion = vi.fn();

const mockOrchestrator = {
  id: 'aurora',
  region: 'eu-west-1',
  ensureTenantReady: (...args: unknown[]) => mockEnsureTenantReady(...args),
  createBucket: (...args: unknown[]) => mockCreateBucket(...args),
};

vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getOrchestratorForRegion: (...args: unknown[]) => {
    mockGetOrchestratorForRegion(...args);
    return mockOrchestrator;
  },
}));

import { baseHandler } from './create-bucket.js';
import { BucketAlreadyExistsError } from '../lib/errors.js';
import { buildEvent } from '../test/lambda-test-utilities.js';
import { S3_REGION, S3Region } from '@filone/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

function validBody() {
  return JSON.stringify({ bucketName: 'my-bucket', region: S3_REGION });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('create-bucket baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureTenantReady.mockResolvedValue('aurora-t-1');
  });

  it('returns 201 and calls orchestrator.createBucket on success', async () => {
    mockCreateBucket.mockResolvedValue(undefined);

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(201);
    expect(mockCreateBucket).toHaveBeenCalledWith('aurora-t-1', {
      bucketName: 'my-bucket',
      versioning: false,
      lock: false,
      retention: undefined,
    });
  });

  it('drives tenant setup via ensureTenantReady before creating the bucket', async () => {
    mockCreateBucket.mockResolvedValue(undefined);

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    await baseHandler(event);

    expect(mockEnsureTenantReady).toHaveBeenCalledWith('org-1');
  });

  it('returns 503 with a retry message when tenant setup fails', async () => {
    mockEnsureTenantReady.mockResolvedValue(null);

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    const body = JSON.parse(result.body as string);
    expect(body.message).toMatch(/setting up the region for you/i);
    expect(mockCreateBucket).not.toHaveBeenCalled();
  });

  it('throws when the orchestrator fails', async () => {
    mockCreateBucket.mockRejectedValue(new Error('Aurora API error'));

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });

    await expect(baseHandler(event)).rejects.toThrow('Aurora API error');
  });

  it('returns 409 when the bucket already exists', async () => {
    mockCreateBucket.mockRejectedValue(new BucketAlreadyExistsError('my-bucket'));

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(409);
  });

  it('passes versioning, lock, and retention to orchestrator.createBucket', async () => {
    mockCreateBucket.mockResolvedValue(undefined);

    const event = buildEvent({
      body: JSON.stringify({
        bucketName: 'my-bucket',
        region: S3_REGION,
        versioning: true,
        lock: true,
        retention: { enabled: true, mode: 'governance', duration: 30, durationType: 'd' },
      }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(201);
    expect(mockCreateBucket).toHaveBeenCalledWith('aurora-t-1', {
      bucketName: 'my-bucket',
      versioning: true,
      lock: true,
      retention: { enabled: true, mode: 'governance', duration: 30, durationType: 'd' },
    });
  });

  it('defaults versioning and lock to false when not provided', async () => {
    mockCreateBucket.mockResolvedValue(undefined);

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(201);
    expect(mockCreateBucket).toHaveBeenCalledWith('aurora-t-1', {
      bucketName: 'my-bucket',
      versioning: false,
      lock: false,
      retention: undefined,
    });
  });

  it('returns 400 when lock is true but versioning is false', async () => {
    const event = buildEvent({
      body: JSON.stringify({ bucketName: 'my-bucket', region: S3_REGION, lock: true }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body as string);
    expect(body.message).toContain('Versioning must be enabled');
    expect(mockCreateBucket).not.toHaveBeenCalled();
  });

  it('returns 400 when retention is provided without lock', async () => {
    const event = buildEvent({
      body: JSON.stringify({
        bucketName: 'my-bucket',
        region: S3_REGION,
        versioning: true,
        retention: { enabled: true, mode: 'governance', duration: 30, durationType: 'd' },
      }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body as string);
    expect(body.message).toContain('Object Lock must be enabled');
    expect(mockCreateBucket).not.toHaveBeenCalled();
  });

  it('selects the orchestrator using the region from the request body', async () => {
    mockCreateBucket.mockResolvedValue(undefined);

    const event = buildEvent({
      body: JSON.stringify({ bucketName: 'my-bucket', region: S3Region.UsEast1 }),
      userInfo: USER_INFO,
    });
    await baseHandler(event);

    expect(mockGetOrchestratorForRegion).toHaveBeenCalledWith(S3Region.UsEast1);
  });

  it('returns 400 when region is unsupported', async () => {
    const event = buildEvent({
      body: JSON.stringify({ bucketName: 'my-bucket', region: 'us-west-2' }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body as string);
    expect(body.message).toContain('Unsupported region');
    expect(mockCreateBucket).not.toHaveBeenCalled();
  });

  it('rejects us-east-1 in production for a non-Foundation user', async () => {
    const previous = process.env.FILONE_STAGE;
    process.env.FILONE_STAGE = 'production';
    try {
      const event = buildEvent({
        body: JSON.stringify({ bucketName: 'my-bucket', region: S3Region.UsEast1 }),
        userInfo: USER_INFO,
      });
      const result = await baseHandler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body as string).message).toContain('Unsupported region');
      expect(mockCreateBucket).not.toHaveBeenCalled();
    } finally {
      process.env.FILONE_STAGE = previous;
    }
  });

  it.skip('accepts us-east-1 in production for a verified Foundation email', async () => {
    const previous = process.env.FILONE_STAGE;
    process.env.FILONE_STAGE = 'production';
    mockCreateBucket.mockResolvedValue(undefined);
    try {
      const event = buildEvent({
        body: JSON.stringify({ bucketName: 'my-bucket', region: S3Region.UsEast1 }),
        userInfo: { ...USER_INFO, email: 'dogfood@fil.org', emailVerified: true },
      });
      await baseHandler(event);

      expect(mockGetOrchestratorForRegion).toHaveBeenCalledWith(S3Region.UsEast1);
    } finally {
      process.env.FILONE_STAGE = previous;
    }
  });
});
