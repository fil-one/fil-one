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

const stageOrchestrators = vi.fn<(stage: string, email?: string) => MockOrchestrator[]>();

vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getAvailableOrchestrators: (stage: string, email?: string) => stageOrchestrators(stage, email),
}));

vi.mock('../lib/org-profile.js', () => ({
  getOrgProfile: vi.fn(async (orgId: string) => ({ pk: { S: `ORG#${orgId}` } })),
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
    aurora.isTenantReady.mockReturnValue('aurora-t-1');
  });

  it('returns 200 with buckets from the orchestrator', async () => {
    aurora.listBuckets.mockResolvedValue([
      {
        bucketName: 'my-bucket',
        region: S3_REGION,
        createdAt: '2026-01-01T00:00:00.000Z',
        isPublic: false,
        versioning: false,
        encrypted: true,
      },
      {
        bucketName: 'other-bucket',
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
          bucketName: 'my-bucket',
          region: S3_REGION,
          createdAt: '2026-01-01T00:00:00.000Z',
          isPublic: false,
          versioning: false,
          encrypted: true,
        },
        {
          bucketName: 'other-bucket',
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
        bucketName: 'versioned-bucket',
        region: S3_REGION,
        createdAt: '2026-01-01T00:00:00.000Z',
        isPublic: false,
        versioning: true,
        encrypted: true,
      },
      {
        bucketName: 'unencrypted-bucket',
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
    const byName = (name: string) =>
      body.buckets.find((bucket: { bucketName: string }) => bucket.bucketName === name);
    expect(byName('versioned-bucket')).toMatchObject({ versioning: true, encrypted: true });
    expect(byName('unencrypted-bucket')).toMatchObject({ versioning: false, encrypted: false });
  });

  it('calls orchestrator.listBuckets with the tenant id', async () => {
    aurora.listBuckets.mockResolvedValue([]);

    const event = buildEvent({ userInfo: USER_INFO });
    await baseHandler(event);

    expect(aurora.listBuckets).toHaveBeenCalledWith('aurora-t-1');
  });

  it('selects orchestrators using the current FILONE_STAGE and no allowlist email by default', async () => {
    aurora.listBuckets.mockResolvedValue([]);

    const event = buildEvent({ userInfo: USER_INFO });
    await baseHandler(event);

    expect(stageOrchestrators).toHaveBeenCalledWith('test', undefined);
  });

  it('passes the verified email to the orchestrator registry for allowlist fan-out', async () => {
    aurora.listBuckets.mockResolvedValue([]);

    const event = buildEvent({
      userInfo: { ...USER_INFO, email: 'dogfood@fil.org', emailVerified: true },
    });
    await baseHandler(event);

    expect(stageOrchestrators).toHaveBeenCalledWith('test', 'dogfood@fil.org');
  });

  it('does not pass an unverified email to the orchestrator registry', async () => {
    aurora.listBuckets.mockResolvedValue([]);

    const event = buildEvent({
      userInfo: { ...USER_INFO, email: 'dogfood@fil.org', emailVerified: false },
    });
    await baseHandler(event);

    expect(stageOrchestrators).toHaveBeenCalledWith('test', undefined);
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
    aurora.isTenantReady.mockReturnValue(null);

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
    aurora.isTenantReady.mockReturnValue('aurora-t-1');
    fth.isTenantReady.mockReturnValue('fth-t-9');
  });

  it('concatenates buckets from every ready orchestrator in registry order', async () => {
    aurora.listBuckets.mockResolvedValue([
      {
        bucketName: 'aurora-bucket',
        region: S3Region.EuWest1,
        createdAt: '2026-01-01T00:00:00.000Z',
        isPublic: false,
        versioning: false,
        encrypted: true,
      },
    ]);
    fth.listBuckets.mockResolvedValue([
      {
        bucketName: 'fth-bucket',
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
          bucketName: 'aurora-bucket',
          region: S3Region.EuWest1,
          createdAt: '2026-01-01T00:00:00.000Z',
          isPublic: false,
          versioning: false,
          encrypted: true,
        },
        {
          bucketName: 'fth-bucket',
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

  it('sorts buckets alphabetically by name across regions', async () => {
    aurora.listBuckets.mockResolvedValue([
      {
        bucketName: 'zebra-bucket',
        region: S3Region.EuWest1,
        createdAt: '2026-01-01T00:00:00.000Z',
        isPublic: false,
        versioning: false,
        encrypted: true,
      },
    ]);
    fth.listBuckets.mockResolvedValue([
      {
        bucketName: 'alpha-bucket',
        region: S3Region.UsEast1,
        createdAt: '2026-02-01T00:00:00.000Z',
        isPublic: false,
        versioning: false,
        encrypted: true,
      },
    ]);

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    const body = JSON.parse(result.body as string);
    expect(body.buckets.map((bucket: { bucketName: string }) => bucket.bucketName)).toStrictEqual([
      'alpha-bucket',
      'zebra-bucket',
    ]);
  });

  it('skips orchestrators whose tenant is not ready', async () => {
    aurora.isTenantReady.mockReturnValue(null);
    fth.listBuckets.mockResolvedValue([
      {
        bucketName: 'fth-bucket',
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
        bucketName: 'fth-bucket',
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
    aurora.isTenantReady.mockReturnValue(null);
    fth.isTenantReady.mockReturnValue(null);

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
