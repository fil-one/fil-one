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

import { baseHandler } from './list-buckets.js';
import { buildEvent } from '../test/lambda-test-utilities.js';
import { S3_REGION, S3Region } from '@filone/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

// Mirrors the message baseHandler builds: the static summary, then one `id (region): reason`
// leg per line in registry order, so a 500 in the logs names both the region and the cause.
const aggregateMessage = (...legs: string[]): string =>
  `One or more orchestrators failed to list buckets:\n${legs.join('\n')}`;

// Returns the parts of the rejection under test as a plain object, so each test can compare
// the whole shape in one assertion. `errors` is non-enumerable on AggregateError, which keeps
// it invisible to matchers like `toMatchObject`.
async function captureAggregateError(
  promise: Promise<unknown>,
): Promise<{ name: string; message: string; errors: unknown[] }> {
  try {
    await promise;
  } catch (error) {
    const aggregate = error as AggregateError;
    return { name: aggregate.name, message: aggregate.message, errors: aggregate.errors };
  }
  throw new Error('Expected the handler to reject, but it resolved');
}

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

    expect(aurora.listBuckets).toHaveBeenCalledWith('aurora-t-1', { includeObjectLock: true });
  });

  it('consults the orchestrator registry to fan out across available regions', async () => {
    aurora.listBuckets.mockResolvedValue([]);

    const event = buildEvent({ userInfo: USER_INFO });
    await baseHandler(event);

    expect(availableOrchestrators).toHaveBeenCalledWith();
  });

  it('wraps the orchestrator error in an AggregateError', async () => {
    const auroraError = new Error('Failed to list buckets from Aurora for tenant aurora-t-1');
    aurora.listBuckets.mockRejectedValue(auroraError);

    const event = buildEvent({ userInfo: USER_INFO });

    expect(await captureAggregateError(baseHandler(event))).toStrictEqual({
      name: 'AggregateError',
      message: aggregateMessage(
        'aurora (eu-west-1): Failed to list buckets from Aurora for tenant aurora-t-1',
      ),
      errors: [auroraError],
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
});

describe('list-buckets baseHandler (multi-region fan-out)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    availableOrchestrators.mockReturnValue([aurora, fth]);
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
    expect(aurora.listBuckets).toHaveBeenCalledWith('aurora-t-1', { includeObjectLock: true });
    expect(fth.listBuckets).toHaveBeenCalledWith('fth-t-9', { includeObjectLock: true });
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

  it('aggregates the failure when a single orchestrator throws', async () => {
    const fthError = new Error('FTH listBuckets blew up');
    aurora.listBuckets.mockResolvedValue([]);
    fth.listBuckets.mockRejectedValue(fthError);

    const event = buildEvent({ userInfo: USER_INFO });

    expect(await captureAggregateError(baseHandler(event))).toStrictEqual({
      name: 'AggregateError',
      message: aggregateMessage('fth (us-east-1): FTH listBuckets blew up'),
      errors: [fthError],
    });
  });

  it('aggregates the failures of every leg in registry order', async () => {
    const auroraError = new Error('Aurora listBuckets blew up');
    const fthError = new Error('FTH listBuckets blew up');
    aurora.listBuckets.mockRejectedValue(auroraError);
    fth.listBuckets.mockRejectedValue(fthError);

    const event = buildEvent({ userInfo: USER_INFO });

    expect(await captureAggregateError(baseHandler(event))).toStrictEqual({
      name: 'AggregateError',
      message: aggregateMessage(
        'aurora (eu-west-1): Aurora listBuckets blew up',
        'fth (us-east-1): FTH listBuckets blew up',
      ),
      errors: [auroraError, fthError],
    });
  });

  it('falls back to string conversion for a leg that rejects with a non-Error', async () => {
    aurora.listBuckets.mockResolvedValue([]);
    fth.listBuckets.mockRejectedValue('socket hang up');

    const event = buildEvent({ userInfo: USER_INFO });

    expect(await captureAggregateError(baseHandler(event))).toStrictEqual({
      name: 'AggregateError',
      message: aggregateMessage('fth (us-east-1): socket hang up'),
      errors: ['socket hang up'],
    });
  });

  it('logs the orchestrator id and region of every failing leg', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const auroraError = new Error('Aurora listBuckets blew up');
    aurora.listBuckets.mockRejectedValue(auroraError);
    fth.listBuckets.mockRejectedValue(new Error('FTH listBuckets blew up'));

    const event = buildEvent({ userInfo: USER_INFO });
    await expect(baseHandler(event)).rejects.toThrow(AggregateError);

    expect(consoleError).toHaveBeenCalledWith('[list-buckets] Orchestrator listBuckets failed', {
      orgId: 'org-1',
      orchestratorId: 'aurora',
      region: 'eu-west-1',
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
});
