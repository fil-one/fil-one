import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

interface MockOrchestrator {
  id: string;
  region: string;
  isTenantReady: ReturnType<typeof vi.fn>;
  listBuckets: ReturnType<typeof vi.fn>;
}

const aurora: MockOrchestrator = {
  id: 'aurora',
  region: 'eu-west-1',
  isTenantReady: vi.fn(),
  listBuckets: vi.fn(),
};

const fth: MockOrchestrator = {
  id: 'fth',
  region: 'us-east-1',
  isTenantReady: vi.fn(),
  listBuckets: vi.fn(),
};

const stageOrchestrators = vi.fn<(stage: string) => MockOrchestrator[]>();

vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getAvailableOrchestrators: (stage: string) => stageOrchestrators(stage),
}));

process.env.FILONE_STAGE = 'test';

import { baseHandler } from './list-buckets.js';
import { buildEvent } from '../test/lambda-test-utilities.js';
import { S3_REGION, S3Region } from '@filone/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('list-buckets baseHandler (single-region)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stageOrchestrators.mockReturnValue([aurora]);
    aurora.isTenantReady.mockResolvedValue('aurora-t-1');
  });

  it('returns 200 with buckets from the orchestrator', async () => {
    aurora.listBuckets.mockResolvedValue([
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
    aurora.listBuckets.mockResolvedValue([
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
    aurora.listBuckets.mockResolvedValue([]);

    const event = buildEvent({ userInfo: USER_INFO });
    await baseHandler(event);

    expect(aurora.listBuckets).toHaveBeenCalledWith('aurora-t-1');
  });

  it('selects orchestrators using the current FILONE_STAGE', async () => {
    aurora.listBuckets.mockResolvedValue([]);

    const event = buildEvent({ userInfo: USER_INFO });
    await baseHandler(event);

    expect(stageOrchestrators).toHaveBeenCalledWith('test');
  });

  it('throws when the orchestrator returns an error', async () => {
    aurora.listBuckets.mockRejectedValue(
      new Error('Failed to list buckets from Aurora for tenant aurora-t-1'),
    );

    const event = buildEvent({ userInfo: USER_INFO });

    await expect(baseHandler(event)).rejects.toThrow(
      'Failed to list buckets from Aurora for tenant aurora-t-1',
    );
  });

  it('returns 200 with empty array when tenant is not ready', async () => {
    aurora.isTenantReady.mockResolvedValue(null);

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body).toStrictEqual({ buckets: [] });
    expect(aurora.listBuckets).not.toHaveBeenCalled();
  });

  it('returns 200 with empty array when no buckets exist', async () => {
    aurora.listBuckets.mockResolvedValue([]);

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body).toStrictEqual({ buckets: [] });
  });
});

describe('list-buckets baseHandler (multi-region fan-out)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stageOrchestrators.mockReturnValue([aurora, fth]);
    aurora.isTenantReady.mockResolvedValue('aurora-t-1');
    fth.isTenantReady.mockResolvedValue('fth-t-9');
  });

  it('concatenates buckets from every ready orchestrator in registry order', async () => {
    aurora.listBuckets.mockResolvedValue([
      {
        name: 'aurora-bucket',
        region: S3Region.EuWest1,
        createdAt: '2026-01-01T00:00:00.000Z',
        isPublic: false,
        versioning: false,
        encrypted: true,
      },
    ]);
    fth.listBuckets.mockResolvedValue([
      {
        name: 'fth-bucket',
        region: S3Region.UsEast1,
        createdAt: '2026-02-01T00:00:00.000Z',
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
          name: 'aurora-bucket',
          region: S3Region.EuWest1,
          createdAt: '2026-01-01T00:00:00.000Z',
          isPublic: false,
          versioning: false,
          encrypted: true,
        },
        {
          name: 'fth-bucket',
          region: S3Region.UsEast1,
          createdAt: '2026-02-01T00:00:00.000Z',
          isPublic: false,
          versioning: false,
          encrypted: true,
        },
      ],
    });
    expect(aurora.listBuckets).toHaveBeenCalledWith('aurora-t-1');
    expect(fth.listBuckets).toHaveBeenCalledWith('fth-t-9');
  });

  it('skips orchestrators whose tenant is not ready', async () => {
    aurora.isTenantReady.mockResolvedValue(null);
    fth.listBuckets.mockResolvedValue([
      {
        name: 'fth-bucket',
        region: S3Region.UsEast1,
        createdAt: '2026-02-01T00:00:00.000Z',
        isPublic: false,
        versioning: false,
        encrypted: true,
      },
    ]);

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.buckets).toStrictEqual([
      {
        name: 'fth-bucket',
        region: S3Region.UsEast1,
        createdAt: '2026-02-01T00:00:00.000Z',
        isPublic: false,
        versioning: false,
        encrypted: true,
      },
    ]);
    expect(aurora.listBuckets).not.toHaveBeenCalled();
  });

  it('returns empty array when no orchestrator has a ready tenant', async () => {
    aurora.isTenantReady.mockResolvedValue(null);
    fth.isTenantReady.mockResolvedValue(null);

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body).toStrictEqual({ buckets: [] });
    expect(aurora.listBuckets).not.toHaveBeenCalled();
    expect(fth.listBuckets).not.toHaveBeenCalled();
  });

  it('propagates the error when any orchestrator throws', async () => {
    aurora.listBuckets.mockResolvedValue([]);
    fth.listBuckets.mockRejectedValue(new Error('FTH listBuckets blew up'));

    const event = buildEvent({ userInfo: USER_INFO });

    await expect(baseHandler(event)).rejects.toThrow('FTH listBuckets blew up');
  });
});
