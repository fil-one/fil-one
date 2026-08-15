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

const availableOrchestrators = vi.fn<() => MockOrchestrator[]>();

vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getAvailableOrchestrators: () => availableOrchestrators(),
}));

vi.mock('../lib/org-profile.js', () => ({
  getOrgProfile: vi.fn(async (orgId: string) => ({ pk: { S: `ORG#${orgId}` } })),
}));

process.env.FILONE_STAGE = 'test';

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: () => ({ before: () => undefined }),
}));

import { baseHandler, handler } from './list-buckets.js';
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';
import { describeRoleEnforcement } from '../test/role-enforcement.js';
import { S3_REGION, S3Region } from '@filone/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

// A degraded region answers with `unavailableRegions` (partial 200) or, when no live region
// answers at all, a 503 carrying this sentence. Mirrors listBucketsUnavailableMessage.
const unavailableMessage = (...regions: string[]): string => {
  const names =
    regions.length > 1
      ? `${regions.slice(0, -1).join(', ')} and ${regions[regions.length - 1]}`
      : regions[0];
  return `Cannot list buckets in the ${names} region${
    regions.length > 1 ? 's' : ''
  }. Please try again later.`;
};

const bucket = (bucketName: string, region: S3Region, createdAt: string) => ({
  bucketName,
  region,
  createdAt,
  isPublic: false,
  versioning: false,
  encrypted: true,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('list-buckets baseHandler (single-region)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    availableOrchestrators.mockReturnValue([aurora]);
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

  it('consults the orchestrator registry to fan out across available regions', async () => {
    aurora.listBuckets.mockResolvedValue([]);

    const event = buildEvent({ userInfo: USER_INFO });
    await baseHandler(event);

    expect(availableOrchestrators).toHaveBeenCalledWith();
  });

  it('returns 503 naming the region when the only provisioned region fails', async () => {
    aurora.listBuckets.mockRejectedValue(
      new Error('Failed to list buckets from Aurora for tenant aurora-t-1'),
    );

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body as string)).toStrictEqual({
      message: unavailableMessage('eu-west-1'),
    });
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

  it('filters by name (FIL-324: filtering moved to the backend)', async () => {
    aurora.listBuckets.mockResolvedValue([
      { bucketName: 'photos-prod', region: S3_REGION, createdAt: '2026-01-01T00:00:00.000Z' },
      { bucketName: 'logs-prod', region: S3_REGION, createdAt: '2026-01-02T00:00:00.000Z' },
    ]);

    const event = buildEvent({ userInfo: USER_INFO, queryStringParameters: { search: 'photos' } });
    const result = await baseHandler(event);

    const body = JSON.parse(result.body as string);
    expect(body.buckets.map((b: { bucketName: string }) => b.bucketName)).toStrictEqual([
      'photos-prod',
    ]);
  });

  it('sorts by the requested key and direction', async () => {
    aurora.listBuckets.mockResolvedValue([
      { bucketName: 'a', region: S3_REGION, createdAt: '2026-01-01T00:00:00.000Z' },
      { bucketName: 'z', region: S3_REGION, createdAt: '2026-01-05T00:00:00.000Z' },
      { bucketName: 'm', region: S3_REGION, createdAt: '2026-01-03T00:00:00.000Z' },
    ]);

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { sortKey: 'createdAt', sortDirection: 'desc' },
    });
    const result = await baseHandler(event);

    const body = JSON.parse(result.body as string);
    expect(body.buckets.map((b: { bucketName: string }) => b.bucketName)).toStrictEqual([
      'z',
      'm',
      'a',
    ]);
  });

  it('falls back to the default sort for an unrecognized sortKey or sortDirection', async () => {
    aurora.listBuckets.mockResolvedValue([
      { bucketName: 'z', region: S3_REGION, createdAt: '2026-01-01T00:00:00.000Z' },
      { bucketName: 'a', region: S3_REGION, createdAt: '2026-01-02T00:00:00.000Z' },
    ]);

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { sortKey: 'nope', sortDirection: 'sideways' },
    });
    const result = await baseHandler(event);

    const body = JSON.parse(result.body as string);
    expect(body.buckets.map((b: { bucketName: string }) => b.bucketName)).toStrictEqual(['a', 'z']);
  });
});

describe('list-buckets baseHandler (multi-region fan-out)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    availableOrchestrators.mockReturnValue([aurora, fth]);
    aurora.isTenantReady.mockReturnValue('aurora-t-1');
    fth.isTenantReady.mockReturnValue('fth-t-9');
  });

  it('skips orchestrators outside the requested region entirely, without calling them', async () => {
    fth.listBuckets.mockResolvedValue([
      { bucketName: 'fth-bucket', region: S3Region.UsEast1, createdAt: '2026-01-01T00:00:00.000Z' },
    ]);

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { region: S3Region.UsEast1 },
    });
    const result = await baseHandler(event);

    const body = JSON.parse(result.body as string);
    expect(body.buckets.map((b: { bucketName: string }) => b.bucketName)).toStrictEqual([
      'fth-bucket',
    ]);
    expect(fth.listBuckets).toHaveBeenCalledWith('fth-t-9');
    expect(aurora.isTenantReady).not.toHaveBeenCalled();
    expect(aurora.listBuckets).not.toHaveBeenCalled();
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

  it("returns the healthy region's buckets and names the failed region", async () => {
    const auroraBucket = bucket('aurora-bucket', S3Region.EuWest1, '2026-01-01T00:00:00.000Z');
    aurora.listBuckets.mockResolvedValue([auroraBucket]);
    fth.listBuckets.mockRejectedValue(new Error('FTH listBuckets blew up'));

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body as string)).toStrictEqual({
      buckets: [auroraBucket],
      unavailableRegions: [S3Region.UsEast1],
    });
  });

  it('returns 503 naming every region in registry order when all of them fail', async () => {
    aurora.listBuckets.mockRejectedValue(new Error('Aurora listBuckets blew up'));
    fth.listBuckets.mockRejectedValue(new Error('FTH listBuckets blew up'));

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body as string)).toStrictEqual({
      message: unavailableMessage('eu-west-1', 'us-east-1'),
    });
  });

  it('keeps a non-Error rejection reason out of the response body', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    aurora.listBuckets.mockResolvedValue([]);
    fth.listBuckets.mockRejectedValue('socket hang up');

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    expect(result.body).not.toContain('socket hang up');
    expect(JSON.parse(result.body as string)).toStrictEqual({
      buckets: [],
      unavailableRegions: [S3Region.UsEast1],
    });
    expect(consoleError).toHaveBeenCalledWith(
      '[list-buckets] Orchestrator listBuckets failed',
      expect.objectContaining({ error: 'socket hang up' }),
    );
    consoleError.mockRestore();
  });

  it('logs the orchestrator id and region of every failing leg', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const auroraError = new Error('Aurora listBuckets blew up');
    aurora.listBuckets.mockRejectedValue(auroraError);
    fth.listBuckets.mockRejectedValue(new Error('FTH listBuckets blew up'));

    const event = buildEvent({ userInfo: USER_INFO });
    await baseHandler(event);

    expect(consoleError).toHaveBeenCalledWith('[list-buckets] Orchestrator listBuckets failed', {
      orgId: 'org-1',
      orchestratorId: 'aurora',
      region: 'eu-west-1',
      tenantId: 'aurora-t-1',
      error: auroraError,
    });
    expect(consoleError).toHaveBeenCalledWith(
      '[list-buckets] Orchestrator listBuckets failed',
      expect.objectContaining({ orchestratorId: 'fth', region: 'us-east-1' }),
    );
    consoleError.mockRestore();
  });

  it('does not log when every orchestrator succeeds', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    aurora.listBuckets.mockResolvedValue([]);
    fth.listBuckets.mockResolvedValue([]);

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('omits unavailableRegions when every orchestrator succeeds', async () => {
    aurora.listBuckets.mockResolvedValue([]);
    fth.listBuckets.mockResolvedValue([]);

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(JSON.parse(result.body as string)).not.toHaveProperty('unavailableRegions');
  });

  it("still sorts the surviving region's buckets when another region fails", async () => {
    aurora.listBuckets.mockResolvedValue([
      bucket('zebra-bucket', S3Region.EuWest1, '2026-01-01T00:00:00.000Z'),
      bucket('alpha-bucket', S3Region.EuWest1, '2026-01-02T00:00:00.000Z'),
    ]);
    fth.listBuckets.mockRejectedValue(new Error('FTH listBuckets blew up'));

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    const body = JSON.parse(result.body as string);
    expect(body.buckets.map((b: { bucketName: string }) => b.bucketName)).toStrictEqual([
      'alpha-bucket',
      'zebra-bucket',
    ]);
    expect(body.unavailableRegions).toStrictEqual([S3Region.UsEast1]);
  });

  // The regression FIL-1049 turns on: without filtering unprovisioned regions out first, a
  // not-ready aurora would count as a healthy leg and this would answer 200 with no buckets.
  it('returns 503 when the only provisioned region fails and the other is not ready', async () => {
    aurora.isTenantReady.mockReturnValue(null);
    fth.listBuckets.mockRejectedValue(new Error('FTH listBuckets blew up'));

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body as string)).toStrictEqual({
      message: unavailableMessage('us-east-1'),
    });
    expect(aurora.listBuckets).not.toHaveBeenCalled();
  });
});

describeRoleEnforcement({
  permission: 'buckets.read',
  invoke: (membership) =>
    handler(buildEvent({ userInfo: { ...USER_INFO, membership } }), buildContext()),
});
