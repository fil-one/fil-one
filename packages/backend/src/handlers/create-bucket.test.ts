import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockCreateAuroraBucket = vi.fn();

vi.mock('../lib/aurora-portal.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/aurora-portal.js')>();
  return {
    ...original,
    createAuroraBucket: (...args: unknown[]) => mockCreateAuroraBucket(...args),
  };
});

const mockEnsureTenantReady = vi.fn();
vi.mock('../lib/aurora-tenant-setup.js', () => ({
  ensureTenantReady: (...args: unknown[]) => mockEnsureTenantReady(...args),
}));

import { baseHandler } from './create-bucket.js';
import { BucketAlreadyExistsError } from '../lib/aurora-portal.js';
import { buildEvent } from '../test/lambda-test-utilities.js';
import { S3_REGION } from '@filone/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

function validBody() {
  return JSON.stringify({ name: 'my-bucket', region: S3_REGION });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('create-bucket baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureTenantReady.mockResolvedValue({ ok: true, auroraTenantId: 'aurora-t-1' });
  });

  it('returns 201 and calls createAuroraBucket on success', async () => {
    mockCreateAuroraBucket.mockResolvedValue(undefined);

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(201);
    expect(mockCreateAuroraBucket).toHaveBeenCalledWith({
      tenantId: 'aurora-t-1',
      bucketName: 'my-bucket',
      versioning: false,
      lock: false,
      retention: undefined,
    });
  });

  it('drives Aurora tenant setup via ensureTenantReady before creating the bucket', async () => {
    mockCreateAuroraBucket.mockResolvedValue(undefined);

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    await baseHandler(event);

    expect(mockEnsureTenantReady).toHaveBeenCalledWith('org-1');
  });

  it('returns 503 with a retry message when tenant setup fails', async () => {
    const errorResponse = {
      statusCode: 503,
      body: JSON.stringify({
        message: 'We are still setting up your account. Please try again in a moment.',
      }),
    };
    mockEnsureTenantReady.mockResolvedValue({ ok: false, errorResponse });

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    const body = JSON.parse(result.body as string);
    expect(body.message).toMatch(/setting up your account/i);
    expect(mockCreateAuroraBucket).not.toHaveBeenCalled();
  });

  it('throws when Aurora Portal API fails', async () => {
    mockCreateAuroraBucket.mockRejectedValue(new Error('Aurora API error'));

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });

    await expect(baseHandler(event)).rejects.toThrow('Aurora API error');
  });

  it('returns 409 when Aurora bucket already exists', async () => {
    mockCreateAuroraBucket.mockRejectedValue(new BucketAlreadyExistsError('my-bucket'));

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(409);
  });

  it('passes versioning, lock, and retention to createAuroraBucket', async () => {
    mockCreateAuroraBucket.mockResolvedValue(undefined);

    const event = buildEvent({
      body: JSON.stringify({
        name: 'my-bucket',
        region: S3_REGION,
        versioning: true,
        lock: true,
        retention: { enabled: true, mode: 'governance', duration: 30, durationType: 'd' },
      }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(201);
    expect(mockCreateAuroraBucket).toHaveBeenCalledWith({
      tenantId: 'aurora-t-1',
      bucketName: 'my-bucket',
      versioning: true,
      lock: true,
      retention: { enabled: true, mode: 'governance', duration: 30, durationType: 'd' },
    });
  });

  it('defaults versioning and lock to false when not provided', async () => {
    mockCreateAuroraBucket.mockResolvedValue(undefined);

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(201);
    expect(mockCreateAuroraBucket).toHaveBeenCalledWith({
      tenantId: 'aurora-t-1',
      bucketName: 'my-bucket',
      versioning: false,
      lock: false,
      retention: undefined,
    });
  });

  it('returns 400 when lock is true but versioning is false', async () => {
    const event = buildEvent({
      body: JSON.stringify({ name: 'my-bucket', region: S3_REGION, lock: true }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body as string);
    expect(body.message).toContain('Versioning must be enabled');
    expect(mockCreateAuroraBucket).not.toHaveBeenCalled();
  });

  it('returns 400 when retention is provided without lock', async () => {
    const event = buildEvent({
      body: JSON.stringify({
        name: 'my-bucket',
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
    expect(mockCreateAuroraBucket).not.toHaveBeenCalled();
  });

  it('returns 400 when region is unsupported', async () => {
    const event = buildEvent({
      body: JSON.stringify({ name: 'my-bucket', region: 'us-west-2' }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body as string);
    expect(body.message).toContain('Unsupported region');
    expect(mockCreateAuroraBucket).not.toHaveBeenCalled();
  });
});
