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

vi.mock('../lib/org-profile.ts', () => ({
  getOrgProfile: vi.fn(async (orgId: string) => ({ pk: { S: `ORG#${orgId}` } })),
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

import { baseHandler } from './get-bucket-rag-engine.ts';
import { buildEvent } from '../test/lambda-test-utilities.ts';
import { fakeOrchestrator, type FakeOrchestrator } from '../test/fake-orchestrator.ts';
import {
  engineStatus,
  engineVersions,
  expectedTarget,
  fakeRagEngine,
  type FakeRagEngine,
} from '../test/fake-rag-engine.ts';
import { RagEngineRequestError } from '../lib/rag-engine-client.ts';
import { ApiErrorCode, S3Region } from '@filone/shared';
import type { AuthenticatedEvent } from '../lib/user-context.ts';

const USER_INFO = {
  userId: '00000000-0000-0000-0000-000000000001',
  orgId: 'org-1',
  email: 'dev@fil.org',
  emailVerified: true,
};

const BUCKET = {
  bucketName: 'my-bucket',
  region: S3Region.UsEast9,
  createdAt: '2026-01-15T10:00:00Z',
  isPublic: false,
  versioning: false,
  encrypted: true,
};

function event(region?: string): AuthenticatedEvent {
  const e = buildEvent({
    userInfo: USER_INFO,
    ...(region ? { queryStringParameters: { region } } : {}),
  });
  e.pathParameters = { name: 'my-bucket' };
  return e;
}

describe('get-bucket-rag-engine baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    engine = fakeRagEngine();
    engineConfigured = true;
    orch = fakeOrchestrator('forgeDev', { bucket: BUCKET, region: S3Region.UsEast9 });
    mockGetOrchestratorForRegion.mockReturnValue(orch);
  });

  it('answers the engine status and the version history', async () => {
    const result = await baseHandler(event(S3Region.UsEast9));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toStrictEqual({
      status: engineStatus(),
      versions: engineVersions().versions,
    });
    const target = expectedTarget('forgeDev', S3Region.UsEast9, 'my-bucket');
    expect(engine.status).toHaveBeenCalledWith(target);
    expect(engine.versions).toHaveBeenCalledWith(target);
  });

  it.each([S3Region.EuWest1, S3Region.UsEast1])('answers 400 for %s', async (region) => {
    const result = await baseHandler(event(region));

    expect(result.statusCode).toBe(400);
    expect(engine.status).not.toHaveBeenCalled();
  });

  it('answers 404 for a bucket the tenant does not own', async () => {
    orch.getBucket.mockResolvedValue(null);

    const result = await baseHandler(event(S3Region.UsEast9));

    expect(result.statusCode).toBe(404);
    expect(engine.status).not.toHaveBeenCalled();
  });

  it('answers 503 when the tenant is not ready', async () => {
    orch.isTenantReady.mockReturnValue(null);

    const result = await baseHandler(event(S3Region.UsEast9));

    expect(result.statusCode).toBe(503);
  });

  it('answers 503 when the stage has no engine', async () => {
    engineConfigured = false;

    const result = await baseHandler(event(S3Region.UsEast9));

    expect(result.statusCode).toBe(503);
  });

  it('answers 409 BUCKET_NOT_INDEXED when the engine has no dataset', async () => {
    engine.versions.mockRejectedValue(new RagEngineRequestError('no dataset', 404));

    const result = await baseHandler(event(S3Region.UsEast9));

    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body!).code).toBe(ApiErrorCode.BUCKET_NOT_INDEXED);
  });
});
