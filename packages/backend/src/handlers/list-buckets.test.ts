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
const mockListBuckets = vi.fn();

const mockOrchestrator = {
  id: 'aurora',
  region: 'eu-west-1',
  isTenantReady: (...args: unknown[]) => mockIsTenantReady(...args),
  listBuckets: (...args: unknown[]) => mockListBuckets(...args),
};

vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getOrchestratorForRegion: () => mockOrchestrator,
}));

process.env.FILONE_STAGE = 'test';

import { baseHandler } from './list-buckets.js';
import { buildEvent } from '../test/lambda-test-utilities.js';
import { S3_REGION } from '@filone/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('list-buckets baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTenantReady.mockResolvedValue('aurora-t-1');
  });

  it('returns 200 with buckets from the orchestrator', async () => {
    mockListBuckets.mockResolvedValue([
      {
        name: 'my-bucket',
        region: S3_REGION,
        createdAt: '2026-01-01T00:00:00.000Z',
        isPublic: false,
        versioning: false,
        encrypted: true,
      },
      {
        name: 'other-bucket',
        region: S3_REGION,
        createdAt: '2026-01-02T00:00:00.000Z',
        isPublic: false,
        versioning: false,
        encrypted: true,
      },
    ]);

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body).toStrictEqual({
      buckets: [
        {
          name: 'my-bucket',
          region: S3_REGION,
          createdAt: '2026-01-01T00:00:00.000Z',
          isPublic: false,
          versioning: false,
          encrypted: true,
        },
        {
          name: 'other-bucket',
          region: S3_REGION,
          createdAt: '2026-01-02T00:00:00.000Z',
          isPublic: false,
          versioning: false,
          encrypted: true,
        },
      ],
    });
  });

  it('passes versioning and encrypted flags through', async () => {
    mockListBuckets.mockResolvedValue([
      {
        name: 'versioned-bucket',
        region: S3_REGION,
        createdAt: '2026-01-01T00:00:00.000Z',
        isPublic: false,
        versioning: true,
        encrypted: true,
      },
      {
        name: 'unencrypted-bucket',
        region: S3_REGION,
        createdAt: '2026-01-02T00:00:00.000Z',
        isPublic: false,
        versioning: false,
        encrypted: false,
      },
    ]);

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.buckets[0]).toMatchObject({ versioning: true, encrypted: true });
    expect(body.buckets[1]).toMatchObject({ versioning: false, encrypted: false });
  });

  it('calls orchestrator.listBuckets with the tenant id', async () => {
    mockListBuckets.mockResolvedValue([]);

    const event = buildEvent({ userInfo: USER_INFO });
    await baseHandler(event);

    expect(mockListBuckets).toHaveBeenCalledWith('aurora-t-1');
  });

  it('throws when the orchestrator returns an error', async () => {
    mockListBuckets.mockRejectedValue(
      new Error('Failed to list buckets from Aurora for tenant aurora-t-1'),
    );

    const event = buildEvent({ userInfo: USER_INFO });

    await expect(baseHandler(event)).rejects.toThrow(
      'Failed to list buckets from Aurora for tenant aurora-t-1',
    );
  });

  it('returns 200 with empty array when tenant is not ready', async () => {
    mockIsTenantReady.mockResolvedValue(null);

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body).toStrictEqual({ buckets: [] });
    expect(mockListBuckets).not.toHaveBeenCalled();
  });

  it('returns 200 with empty array when no buckets exist', async () => {
    mockListBuckets.mockResolvedValue([]);

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body).toStrictEqual({ buckets: [] });
  });
});
