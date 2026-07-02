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
const mockGetBucket = vi.fn();
const mockGetOrchestratorForRegion = vi.fn();

const mockOrchestrator = {
  id: 'aurora',
  region: 'eu-west-1',
  isTenantReady: (...args: unknown[]) => mockIsTenantReady(...args),
  getBucket: (...args: unknown[]) => mockGetBucket(...args),
};

vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getOrchestratorForRegion: (...args: unknown[]) => mockGetOrchestratorForRegion(...args),
}));

vi.mock('../lib/org-profile.js', () => ({
  getOrgProfile: vi.fn(async (orgId: string) => ({ pk: { S: `ORG#${orgId}` } })),
}));

const mockGetEnablement = vi.fn();
vi.mock('../lib/bucket-rag-enablement.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/bucket-rag-enablement.js')>(
    '../lib/bucket-rag-enablement.js',
  );
  return {
    ...actual,
    getBucketRagEnablement: (...args: unknown[]) => mockGetEnablement(...args),
  };
});

// The real ragAccessMiddleware resolves access via hasRagAccess → isAllowlisted,
// which reads UserInfoTable with a single GetItemCommand. We drive that path
// with aws-sdk-client-mock so the *real* gate runs end-to-end. A non-foundation
// email is used so the decision hinges on the (mocked) allowlist lookup.
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

const ddbMock = mockClient(DynamoDBClient);

// The full middy chain runs auth + subscription guard before the RAG gate.
// Those have their own dedicated tests; here we replace them with pass-through
// middleware so the gate's wiring can be exercised in isolation. The userInfo
// the auth middleware would populate is stamped by buildEvent instead.
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: () => ({ before: () => undefined }),
}));
vi.mock('../middleware/subscription-guard.js', () => ({
  AccessLevel: { Read: 'read', Write: 'write' },
  subscriptionGuardMiddleware: () => ({ before: () => undefined }),
}));

process.env.FILONE_STAGE = 'test';

import { baseHandler, handler } from './get-bucket-rag-enablement.js';
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';
import { S3_REGION, S3Region } from '@filone/shared';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import type { BucketRAGEnablementRecord } from '../lib/dynamo-records.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1', email: 'dev@fil.org', emailVerified: true };

const BUCKET = {
  bucketName: 'my-bucket',
  region: S3_REGION,
  createdAt: '2026-01-15T10:00:00Z',
  isPublic: false,
};

function enablementRecord(
  over: Partial<BucketRAGEnablementRecord> = {},
): BucketRAGEnablementRecord {
  return {
    pk: 'BUCKET#eu-west-1#my-bucket',
    sk: 'RAG',
    orgId: 'org-1',
    status: 'active',
    filesIndexed: 12,
    indexSize: 2048,
    lastSyncedAt: '2026-06-22T12:00:00Z',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-22T12:00:00Z',
    ...over,
  };
}

function event(query?: Record<string, string>): AuthenticatedEvent {
  const e = buildEvent({ userInfo: USER_INFO, ...(query ? { queryStringParameters: query } : {}) });
  e.pathParameters = { name: 'my-bucket' };
  return e;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('get-bucket-rag-enablement baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTenantReady.mockReturnValue('aurora-t-1');
    mockGetOrchestratorForRegion.mockReturnValue(mockOrchestrator);
    mockGetBucket.mockResolvedValue(BUCKET);
    mockGetEnablement.mockResolvedValue(enablementRecord());
  });

  it('returns 200 with enablement state and sync telemetry (happy path)', async () => {
    const result = await baseHandler(event());

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toStrictEqual({
      enabled: true,
      status: 'active',
      filesIndexed: 12,
      indexSize: 2048,
      lastSyncedAt: '2026-06-22T12:00:00Z',
    });
  });

  it('reads the enablement row by region + bucket name', async () => {
    await baseHandler(event());
    expect(mockGetEnablement).toHaveBeenCalledWith('org-1', S3_REGION, 'my-bucket');
  });

  it('forwards the resolved region from the query param into the helper', async () => {
    await baseHandler(event({ region: S3Region.UsEast1 }));
    expect(mockGetEnablement).toHaveBeenCalledWith('org-1', S3Region.UsEast1, 'my-bucket');
  });

  it('returns enabled:false with zeroed telemetry for a never-enabled bucket', async () => {
    mockGetEnablement.mockResolvedValue(undefined);

    const result = await baseHandler(event());

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toStrictEqual({
      enabled: false,
      status: 'disabled',
      filesIndexed: 0,
      indexSize: 0,
    });
  });

  it('reports a disabled record as enabled:false', async () => {
    mockGetEnablement.mockResolvedValue(enablementRecord({ status: 'disabled' }));

    const result = await baseHandler(event());

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!).enabled).toBe(false);
    expect(JSON.parse(result.body!).status).toBe('disabled');
  });

  it('omits lastSyncedAt for a bucket that has never synced', async () => {
    mockGetEnablement.mockResolvedValue(
      enablementRecord({ filesIndexed: 0, indexSize: 0, lastSyncedAt: undefined }),
    );

    const result = await baseHandler(event());

    expect(JSON.parse(result.body!)).toStrictEqual({
      enabled: true,
      status: 'active',
      filesIndexed: 0,
      indexSize: 0,
    });
  });

  it('ignores an enablement record stamped with a different org (defense in depth)', async () => {
    mockGetEnablement.mockResolvedValue(enablementRecord({ orgId: 'other-org' }));

    const result = await baseHandler(event());

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toStrictEqual({
      enabled: false,
      status: 'disabled',
      filesIndexed: 0,
      indexSize: 0,
    });
  });

  it('returns 404 when the bucket is not in the caller tenant (cross-tenant scope)', async () => {
    mockGetBucket.mockResolvedValue(null);

    const result = await baseHandler(event());

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body!).message).toBe('Bucket not found');
    expect(mockGetEnablement).not.toHaveBeenCalled();
  });

  it('returns 400 when the bucket name is missing', async () => {
    const e = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(e);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body!).message).toBe('Bucket name is required');
  });

  it('returns 503 when the tenant is not ready', async () => {
    mockIsTenantReady.mockReturnValue(null);
    const result = await baseHandler(event());
    expect(result.statusCode).toBe(503);
    expect(mockGetBucket).not.toHaveBeenCalled();
  });

  it('returns 400 for an unsupported region', async () => {
    const result = await baseHandler(event({ region: 'us-west-2' }));
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body!).message).toContain('Unsupported region');
    expect(mockGetOrchestratorForRegion).not.toHaveBeenCalled();
  });

  it('selects the orchestrator from the region query param', async () => {
    await baseHandler(event({ region: S3Region.UsEast1 }));
    expect(mockGetOrchestratorForRegion).toHaveBeenCalledWith(S3Region.UsEast1);
  });
});

describe('get-bucket-rag-enablement handler (RAG access gate)', () => {
  // Non-foundation email so the gate decision hinges on the allowlist lookup.
  function gateEvent(): AuthenticatedEvent {
    const e = buildEvent({
      userInfo: {
        userId: 'user-1',
        orgId: 'org-1',
        email: 'outsider@example.com',
        emailVerified: true,
      },
    });
    e.pathParameters = { name: 'my-bucket' };
    return e;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    mockIsTenantReady.mockReturnValue('aurora-t-1');
    mockGetOrchestratorForRegion.mockReturnValue(mockOrchestrator);
    mockGetBucket.mockResolvedValue(BUCKET);
    mockGetEnablement.mockResolvedValue(enablementRecord());
  });

  it('returns 403 when the caller is not foundation and not allowlisted', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    const result = await handler(gateEvent(), buildContext());

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body!).message).toBe('You do not have access to this feature.');
    // Gate runs before any RAG work.
    expect(mockGetEnablement).not.toHaveBeenCalled();
  });

  it('allows the request through the gate when the caller is allowlisted', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: { pk: { S: 'ALLOWLIST#outsider@example.com' } } });

    const result = await handler(gateEvent(), buildContext());

    expect(result.statusCode).toBe(200);
    expect(mockGetEnablement).toHaveBeenCalled();
  });
});
