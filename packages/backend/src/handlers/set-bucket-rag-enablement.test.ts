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

vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getOrchestratorForRegion: (...args: unknown[]) => mockGetOrchestratorForRegion(...args),
}));

vi.mock('../lib/org-profile.js', () => ({
  getOrgProfile: vi.fn(async (orgId: string) => ({ pk: { S: `ORG#${orgId}` } })),
}));

const mockGetEnablement = vi.fn();
const mockSetEnablement = vi.fn();
vi.mock('../lib/bucket-rag-enablement.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/bucket-rag-enablement.js')>(
    '../lib/bucket-rag-enablement.js',
  );
  return {
    ...actual,
    getBucketRagEnablement: (...args: unknown[]) => mockGetEnablement(...args),
    setBucketRagEnablement: (...args: unknown[]) => mockSetEnablement(...args),
  };
});

import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

const ddbMock = mockClient(DynamoDBClient);

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: () => ({ before: () => undefined }),
}));
vi.mock('../middleware/subscription-guard.js', () => ({
  AccessLevel: { Read: 'read', Write: 'write' },
  subscriptionGuardMiddleware: () => ({ before: () => undefined }),
}));

process.env.FILONE_STAGE = 'test';

import { baseHandler, handler } from './set-bucket-rag-enablement.js';
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';
import { fakeOrchestrator, type FakeOrchestrator } from '../test/fake-orchestrator.js';
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
  versioning: false,
  encrypted: true,
};

function record(over: Partial<BucketRAGEnablementRecord> = {}): BucketRAGEnablementRecord {
  return {
    pk: 'BUCKET#eu-west-1#my-bucket',
    sk: 'RAG',
    orgId: 'org-1',
    status: 'active',
    filesIndexed: 0,
    indexSize: 0,
    createdAt: '2026-06-22T12:00:00Z',
    updatedAt: '2026-06-22T12:00:00Z',
    ...over,
  };
}

function event(body: unknown): AuthenticatedEvent {
  const e = buildEvent({
    userInfo: USER_INFO,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    method: 'POST',
  });
  e.pathParameters = { name: 'my-bucket' };
  return e;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('set-bucket-rag-enablement baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orch = fakeOrchestrator('aurora', { bucket: BUCKET });
    mockGetOrchestratorForRegion.mockReturnValue(orch);
    mockGetEnablement.mockResolvedValue(undefined);
    mockSetEnablement.mockImplementation(async (args: { enabled: boolean }) =>
      record({ status: args.enabled ? 'active' : 'disabled' }),
    );
  });

  it('enables RAG and returns 200 with the active enablement state', async () => {
    const result = await baseHandler(event({ enabled: true }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toMatchObject({ enabled: true, status: 'active' });
    expect(mockSetEnablement).toHaveBeenCalledWith({
      region: S3_REGION,
      bucketName: 'my-bucket',
      orgId: 'org-1',
      enabled: true,
      existing: undefined,
    });
  });

  it('forwards the resolved region from the query param into both helpers', async () => {
    const e = event({ enabled: true });
    e.queryStringParameters = { region: S3Region.UsEast1 };

    await baseHandler(e);

    expect(mockGetEnablement).toHaveBeenCalledWith('org-1', S3Region.UsEast1, 'my-bucket');
    expect(mockSetEnablement).toHaveBeenCalledWith(
      expect.objectContaining({ region: S3Region.UsEast1, bucketName: 'my-bucket' }),
    );
  });

  it('disables RAG and returns status disabled', async () => {
    const result = await baseHandler(event({ enabled: false }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toMatchObject({ enabled: false, status: 'disabled' });
    expect(mockSetEnablement).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, orgId: 'org-1' }),
    );
  });

  it('passes the existing record through so telemetry/createdAt is preserved', async () => {
    const existing = record({ filesIndexed: 50, createdAt: '2026-01-01T00:00:00Z' });
    mockGetEnablement.mockResolvedValue(existing);

    await baseHandler(event({ enabled: true }));

    expect(mockSetEnablement).toHaveBeenCalledWith(expect.objectContaining({ existing }));
  });

  it('does not carry over an existing record stamped with a different org', async () => {
    mockGetEnablement.mockResolvedValue(record({ orgId: 'other-org', filesIndexed: 99 }));

    await baseHandler(event({ enabled: true }));

    expect(mockSetEnablement).toHaveBeenCalledWith(
      expect.objectContaining({ existing: undefined }),
    );
  });

  it('returns 404 when the bucket is not in the caller tenant (cross-tenant scope)', async () => {
    orch.getBucket.mockResolvedValue(null);

    const result = await baseHandler(event({ enabled: true }));

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body!).message).toBe('Bucket not found');
    expect(mockSetEnablement).not.toHaveBeenCalled();
  });

  it('returns 400 when the bucket name is missing', async () => {
    const e = buildEvent({ userInfo: USER_INFO, body: JSON.stringify({ enabled: true }) });
    const result = await baseHandler(e);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body!).message).toBe('Bucket name is required');
  });

  it('returns 400 on invalid JSON body', async () => {
    const result = await baseHandler(event('{not json'));
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body!).message).toBe('Invalid JSON body');
    expect(mockSetEnablement).not.toHaveBeenCalled();
  });

  it('returns 400 when enabled is missing', async () => {
    const result = await baseHandler(event({}));
    expect(result.statusCode).toBe(400);
    expect(mockSetEnablement).not.toHaveBeenCalled();
  });

  it('returns 400 when enabled is not a boolean', async () => {
    const result = await baseHandler(event({ enabled: 'yes' }));
    expect(result.statusCode).toBe(400);
    expect(mockSetEnablement).not.toHaveBeenCalled();
  });

  it('returns 503 when the tenant is not ready', async () => {
    orch.isTenantReady.mockReturnValue(null);
    const result = await baseHandler(event({ enabled: true }));
    expect(result.statusCode).toBe(503);
    expect(orch.getBucket).not.toHaveBeenCalled();
    expect(mockSetEnablement).not.toHaveBeenCalled();
  });
});

const MOCK_CSRF_TOKEN = 'csrf-token-value';

describe('set-bucket-rag-enablement handler (RAG access gate)', () => {
  function gateEvent(): AuthenticatedEvent {
    const e = buildEvent({
      userInfo: {
        userId: 'user-1',
        orgId: 'org-1',
        email: 'outsider@example.com',
        emailVerified: true,
      },
      cookies: [`hs_csrf_token=${MOCK_CSRF_TOKEN}`],
      body: JSON.stringify({ enabled: true }),
      method: 'POST',
    });
    e.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;
    e.pathParameters = { name: 'my-bucket' };
    return e;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    orch = fakeOrchestrator('aurora', { bucket: BUCKET });
    mockGetOrchestratorForRegion.mockReturnValue(orch);
    mockGetEnablement.mockResolvedValue(undefined);
    mockSetEnablement.mockResolvedValue(record());
  });

  it('returns 403 when the caller is not foundation and not allowlisted', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    const result = await handler(gateEvent(), buildContext());

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body!).message).toBe('You do not have access to this feature.');
    // Gate runs before any write.
    expect(mockSetEnablement).not.toHaveBeenCalled();
  });

  it('allows the request through the gate when the caller is allowlisted', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: { pk: { S: 'ALLOWLIST#outsider@example.com' } } });

    const result = await handler(gateEvent(), buildContext());

    expect(result.statusCode).toBe(200);
    expect(mockSetEnablement).toHaveBeenCalled();
  });

  it('rejects a POST without a valid CSRF token (csrf protection in place)', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: { pk: { S: 'ALLOWLIST#outsider@example.com' } } });

    // Same allowlisted caller, but missing the CSRF cookie/header pair.
    const e = buildEvent({
      userInfo: {
        userId: 'user-1',
        orgId: 'org-1',
        email: 'outsider@example.com',
        emailVerified: true,
      },
      body: JSON.stringify({ enabled: true }),
      method: 'POST',
    });
    e.pathParameters = { name: 'my-bucket' };

    const result = await handler(e, buildContext());

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body!).message).toBe('CSRF validation failed');
    // CSRF runs before any write.
    expect(mockSetEnablement).not.toHaveBeenCalled();
  });
});
