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
import { buildEvent, membershipFor } from '../test/lambda-test-utilities.ts';
import {
  fakeOrchestrator,
  stubMemberScopedGetBucket,
  tenantFor,
  type FakeOrchestrator,
} from '../test/fake-orchestrator.ts';
import { FakeIamOrchestrator } from '../test/fake-iam-orchestrator.ts';
import { policyOf, statement } from '../test/policy-statements.ts';
import {
  engineStatus,
  expectedTarget,
  fakeRagEngine,
  type FakeRagEngine,
} from '../test/fake-rag-engine.ts';
import { RAG_ENGINE_SYNC_FAILED_MESSAGE, RagEngineRequestError } from '../lib/rag-engine-client.ts';
import { OrgRole, S3Region, type PolicyAction } from '@filone/shared';
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

  it('answers a failed sync with fixed text and logs the engine’s text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    engine.sync.mockResolvedValue(
      engineStatus({
        syncState: 'error',
        lastSyncError: 'connect ECONNREFUSED ingot.internal:9000',
      }),
    );

    try {
      const result = await baseHandler(event(S3Region.EuCentral3));

      expect(result.statusCode).toBe(202);
      const body = JSON.parse(result.body!);
      expect(body.syncState).toBe('error');
      expect(body.lastSyncError).toBe(RAG_ENGINE_SYNC_FAILED_MESSAGE);
      expect(result.body).not.toContain('ingot.internal');
      expect(JSON.stringify(warn.mock.calls)).toContain('ingot.internal:9000');
    } finally {
      warn.mockRestore();
    }
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

describe('sync-bucket-rag member scope on an iam region', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    engine = fakeRagEngine();
    engineConfigured = true;
    mockIsOrgDeleting.mockResolvedValue(false);
    mockGetEnablement.mockResolvedValue({ orgId: 'org-1', status: 'active' });
  });

  /** An iam orchestrator whose policy on my-bucket grants the user `actions`. */
  function useIamOrchestratorGrantingOnMyBucket(actions: PolicyAction[]): void {
    const iam = new FakeIamOrchestrator();
    iam.seedPrincipal(tenantFor('forge', 'org-1'), USER_INFO.userId);
    iam.seedPolicy(
      tenantFor('forge', 'org-1'),
      'my-bucket',
      policyOf(statement('my-bucket', 'Allow', [USER_INFO.userId], actions)),
    );
    orch = fakeOrchestrator('forge', {
      bucket: BUCKET,
      iam,
      region: S3Region.EuCentral3,
    });
    stubMemberScopedGetBucket(orch, iam, BUCKET);
    mockGetOrchestratorForRegion.mockReturnValue(orch);
  }

  function memberEvent(role: OrgRole): AuthenticatedEvent {
    const e = buildEvent({
      userInfo: {
        ...USER_INFO,
        membership: membershipFor(USER_INFO.orgId, USER_INFO.userId, role),
      },
      method: 'POST',
      queryStringParameters: { region: S3Region.EuCentral3 },
    });
    e.pathParameters = { name: 'my-bucket' };
    return e;
  }

  // The engine lists and reads every object with the tenant key.
  it.each([
    ['only s3:PutObject', ['s3:PutObject']],
    ['s3:ListBucket but not s3:GetObject', ['s3:ListBucket']],
    ['s3:GetObject but not s3:ListBucket', ['s3:GetObject']],
  ] as const)('refuses a Member whose policy grants %s', async (_grant, actions) => {
    useIamOrchestratorGrantingOnMyBucket([...actions]);

    const result = await baseHandler(memberEvent(OrgRole.Member));

    expect(result.statusCode).toBe(403);
    expect(engine.sync).not.toHaveBeenCalled();
  });

  it('lets a Member whose policy grants listing and reading start a sync', async () => {
    useIamOrchestratorGrantingOnMyBucket(['s3:ListBucket', 's3:GetObject']);

    const result = await baseHandler(memberEvent(OrgRole.Member));

    expect(result.statusCode).toBe(202);
  });
});
