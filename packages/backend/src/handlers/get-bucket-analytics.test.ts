import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import type { ModelStorageMetricsSample } from '../lib/aurora-backoffice.js';
import { FINAL_SETUP_STATUS } from '../lib/org-setup-status.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockGetBucketStorageSamples = vi.fn<() => Promise<ModelStorageMetricsSample[]>>();

vi.mock('../lib/aurora-backoffice.js', () => ({
  getBucketStorageSamples: (...args: unknown[]) => mockGetBucketStorageSamples(...(args as [])),
}));

const mockGetAuroraPortalApiKey = vi.fn();
vi.mock('../lib/aurora-portal.js', () => ({
  getAuroraPortalApiKey: (...args: unknown[]) => mockGetAuroraPortalApiKey(...args),
}));

const mockGetBucketInfo = vi.fn();
vi.mock('@filone/aurora-portal-client', () => ({
  createClient: () => 'mock-client',
  getBucketInfo: (...args: unknown[]) => mockGetBucketInfo(...args),
}));

vi.mock('../lib/auth-secrets.js', () => ({
  getAuthSecrets: () => ({
    AUTH0_CLIENT_ID: 'test-client-id',
    AUTH0_CLIENT_SECRET: 'test-client-secret',
  }),
}));

const mockJwtVerify = vi.fn();
vi.mock('jose', () => ({
  jwtVerify: (token: unknown, jwks: unknown, opts: unknown) => mockJwtVerify(token, jwks, opts),
  decodeJwt: vi.fn(),
  createRemoteJWKSet: vi.fn((_url: unknown) => 'mock-jwks'),
}));

process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.com';
process.env.FILONE_STAGE = 'test';
process.env.AURORA_PORTAL_URL = 'https://portal.dev.aur.lu';

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './get-bucket-analytics.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1', email: 'user@example.com' };
const AURORA_TENANT_ID = 'aurora-tenant-1';

function orgProfileWithTenant(tenantId: string) {
  return {
    Item: {
      pk: { S: `ORG#${USER_INFO.orgId}` },
      sk: { S: 'PROFILE' },
      auroraTenantId: { S: tenantId },
      setupStatus: { S: FINAL_SETUP_STATUS },
    },
  };
}

function authenticatedEvent(bucketName?: string) {
  const event = buildEvent({
    userInfo: USER_INFO,
  });
  if (bucketName) {
    event.pathParameters = { name: bucketName };
  }
  return event;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/buckets/{name}/analytics handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    mockGetBucketStorageSamples.mockResolvedValue([]);
    mockGetAuroraPortalApiKey.mockResolvedValue('test-api-key');
    mockGetBucketInfo.mockResolvedValue({
      data: { name: 'my-bucket', createdAt: '2026-01-15T10:00:00Z' },
      error: undefined,
      response: { status: 200 },
    });
  });

  it('returns analytics from Aurora', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant(AURORA_TENANT_ID));
    mockGetBucketStorageSamples.mockResolvedValue([
      { timestamp: '2026-01-01T00:00:00Z', bytesUsed: 4000, objectCount: 3 },
    ]);

    const result = await baseHandler(authenticatedEvent('my-bucket'));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({ objectCount: 3, bytesUsed: 4000 });
  });

  it('returns zeros when Aurora returns empty samples', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant(AURORA_TENANT_ID));
    mockGetBucketStorageSamples.mockResolvedValue([]);

    const result = await baseHandler(authenticatedEvent('my-bucket'));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({ objectCount: 0, bytesUsed: 0 });
  });

  it('uses the last sample for values', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant(AURORA_TENANT_ID));
    mockGetBucketStorageSamples.mockResolvedValue([
      { timestamp: '2026-01-01T00:00:00Z', bytesUsed: 1000, objectCount: 2 },
      { timestamp: '2026-01-15T00:00:00Z', bytesUsed: 5000, objectCount: 8 },
    ]);

    const result = await baseHandler(authenticatedEvent('my-bucket'));

    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({ objectCount: 8, bytesUsed: 5000 });
  });

  it('returns 400 when bucket name is missing', async () => {
    const result = await baseHandler(authenticatedEvent());

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({ message: 'Bucket name is required' });
  });

  it('returns 503 when auroraTenantId is missing', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        pk: { S: `ORG#${USER_INFO.orgId}` },
        sk: { S: 'PROFILE' },
      },
    });

    const result = await baseHandler(authenticatedEvent('my-bucket'));

    expect(result.statusCode).toBe(503);
    expect(mockGetBucketStorageSamples).not.toHaveBeenCalled();
  });

  it('returns 503 when org setup is not complete', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        pk: { S: `ORG#${USER_INFO.orgId}` },
        sk: { S: 'PROFILE' },
        auroraTenantId: { S: AURORA_TENANT_ID },
        setupStatus: { S: 'AURORA_TENANT_SETUP_COMPLETE' },
      },
    });

    const result = await baseHandler(authenticatedEvent('my-bucket'));

    expect(result.statusCode).toBe(503);
    expect(mockGetBucketStorageSamples).not.toHaveBeenCalled();
  });

  it('returns 404 when bucket is not owned by the org', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant(AURORA_TENANT_ID));
    mockGetBucketInfo.mockResolvedValue({
      data: undefined,
      error: { message: 'Not found' },
      response: { status: 404 },
    });

    const result = await baseHandler(authenticatedEvent('other-orgs-bucket'));

    expect(result.statusCode).toBe(404);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({ message: 'Bucket not found' });
    expect(mockGetBucketStorageSamples).not.toHaveBeenCalled();
  });

  it('throws when portal returns a non-404 error', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant(AURORA_TENANT_ID));
    mockGetBucketInfo.mockResolvedValue({
      data: undefined,
      error: { message: 'Internal error' },
      response: { status: 500 },
    });

    await expect(baseHandler(authenticatedEvent('my-bucket'))).rejects.toThrow(
      `Failed to verify bucket "my-bucket" ownership for tenant ${AURORA_TENANT_ID}`,
    );
    expect(mockGetBucketStorageSamples).not.toHaveBeenCalled();
  });

  it('verifies bucket ownership with correct tenant ID', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant(AURORA_TENANT_ID));
    mockGetBucketStorageSamples.mockResolvedValue([
      { timestamp: '2026-01-01T00:00:00Z', bytesUsed: 1000, objectCount: 1 },
    ]);

    await baseHandler(authenticatedEvent('my-bucket'));

    expect(mockGetAuroraPortalApiKey).toHaveBeenCalledWith('test', AURORA_TENANT_ID);
    expect(mockGetBucketInfo).toHaveBeenCalledWith({
      client: 'mock-client',
      path: { tenantId: AURORA_TENANT_ID, bucketName: 'my-bucket' },
      throwOnError: false,
    });
  });
});
