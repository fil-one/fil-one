import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockGetOrchestratorForRegion = vi.fn();

let orch: FakeOrchestrator;

vi.mock('../lib/service-orchestrator-registry.ts', () => ({
  getOrchestratorForRegion: (...args: unknown[]) => mockGetOrchestratorForRegion(...args),
}));

const mockIsOrgDeleting = vi.fn(async () => false);
vi.mock('../lib/org-profile.ts', () => ({
  getOrgProfile: vi.fn(async (orgId: string) => ({ pk: { S: `ORG#${orgId}` } })),
  isOrgDeleting: () => mockIsOrgDeleting(),
}));

const mockGetEnablement = vi.fn();
vi.mock('../lib/bucket-rag-enablement.ts', () => ({
  getBucketRagEnablement: (...args: unknown[]) => mockGetEnablement(...args),
}));

let engine: FakeRagEngine = fakeRagEngine();
let engineConfigured = true;
vi.mock('../lib/rag-engine-client.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/rag-engine-client.ts')>(
    '../lib/rag-engine-client.ts',
  );
  return {
    ...actual,
    getRagEngineClient: () => {
      if (!engineConfigured) throw new actual.RagEngineNotConfiguredError();
      return engine;
    },
  };
});

process.env.FILONE_STAGE = 'test';

import { baseHandler } from './sync-bucket-rag.ts';
import { buildEvent } from '../test/lambda-test-utilities.ts';
import { fakeOrchestrator, type FakeOrchestrator } from '../test/fake-orchestrator.ts';
import {
  engineStatus,
  expectedTarget,
  fakeRagEngine,
  type FakeRagEngine,
} from '../test/fake-rag-engine.ts';
import { RagEngineRequestError } from '../lib/rag-engine-client.ts';
import { S3Region } from '@filone/shared';
import type { AuthenticatedEvent } from '../lib/user-context.ts';

const USER_INFO = {
  userId: '00000000-0000-0000-0000-000000000001',
  orgId: 'org-1',
  email: 'dev@fil.org',
  emailVerified: true,
};

const BUCKET = {
  bucketName: 'my-bucket',
  region: S3Region.EuCentral3,
  createdAt: '2026-01-15T10:00:00Z',
  isPublic: false,
  versioning: false,
  encrypted: true,
};

function event(region?: string): AuthenticatedEvent {
  const e = buildEvent({
    userInfo: USER_INFO,
    method: 'POST',
    ...(region ? { queryStringParameters: { region } } : {}),
  });
  e.pathParameters = { name: 'my-bucket' };
  return e;
}

describe('sync-bucket-rag baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    engine = fakeRagEngine();
    engineConfigured = true;
    orch = fakeOrchestrator('forge', { bucket: BUCKET, region: S3Region.EuCentral3 });
    mockGetOrchestratorForRegion.mockReturnValue(orch);
    mockIsOrgDeleting.mockResolvedValue(false);
    mockGetEnablement.mockResolvedValue({ orgId: 'org-1', status: 'active' });
  });

  it('starts a sync on the engine and answers 202 with its status', async () => {
    const result = await baseHandler(event(S3Region.EuCentral3));

    expect(result.statusCode).toBe(202);
    expect(engine.sync).toHaveBeenCalledWith(
      expectedTarget('forge', S3Region.EuCentral3, 'my-bucket'),
    );
    expect(JSON.parse(result.body!)).toStrictEqual(engineStatus({ syncState: 'syncing' }));
  });

  it.each([S3Region.EuWest1, S3Region.UsEast1])(
    'answers 400 for %s, which indexes on the schedule',
    async (region) => {
      const result = await baseHandler(event(region));

      expect(result.statusCode).toBe(400);
      expect(mockGetOrchestratorForRegion).not.toHaveBeenCalled();
      expect(engine.sync).not.toHaveBeenCalled();
    },
  );

  it('answers 400 with no region (the default region is not on the engine)', async () => {
    const result = await baseHandler(event());
    expect(result.statusCode).toBe(400);
  });

  it('answers 400 for an unsupported region', async () => {
    const result = await baseHandler(event('us-west-2'));
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body!).message).toContain('Unsupported region');
  });

  it('answers 404 for a bucket the tenant does not own', async () => {
    orch.getBucket.mockResolvedValue(null);

    const result = await baseHandler(event(S3Region.EuCentral3));

    expect(result.statusCode).toBe(404);
    expect(engine.sync).not.toHaveBeenCalled();
  });

  it.each([
    ['never enabled', undefined],
    ['disabled', { orgId: 'org-1', status: 'disabled' }],
    ['stamped with another org', { orgId: 'org-2', status: 'active' }],
  ])('answers 409 for a bucket %s', async (_case, row) => {
    mockGetEnablement.mockResolvedValue(row);

    const result = await baseHandler(event(S3Region.EuCentral3));

    expect(result.statusCode).toBe(409);
    expect(engine.sync).not.toHaveBeenCalled();
  });

  it('answers 410 while the org is being deleted', async () => {
    mockIsOrgDeleting.mockResolvedValue(true);

    const result = await baseHandler(event(S3Region.EuCentral3));

    expect(result.statusCode).toBe(410);
    expect(engine.sync).not.toHaveBeenCalled();
  });

  it('answers 503 when the stage has no engine', async () => {
    engineConfigured = false;

    const result = await baseHandler(event(S3Region.UsEast9));

    expect(result.statusCode).toBe(503);
  });

  it('answers 502 when the engine fails', async () => {
    engine.sync.mockRejectedValue(new RagEngineRequestError('boom', 500));

    const result = await baseHandler(event(S3Region.EuCentral3));

    expect(result.statusCode).toBe(502);
  });
});
