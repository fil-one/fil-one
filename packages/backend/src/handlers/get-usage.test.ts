import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import type {
  ModelStorageMetricsSample,
  ModelOperationMetricsSample,
  ModelsTenantWithMetricsManagementResponse,
} from '../lib/aurora-backoffice.js';
import { FINAL_SETUP_STATUS } from '../lib/org-setup-status.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockGetStorageSamples = vi.fn<() => Promise<ModelStorageMetricsSample[]>>();
const mockGetOperationsSamples = vi.fn<() => Promise<ModelOperationMetricsSample[]>>();
const mockGetTenantInfo = vi.fn<() => Promise<ModelsTenantWithMetricsManagementResponse | null>>();

vi.mock('../lib/aurora-backoffice.js', () => ({
  getStorageSamples: (...args: unknown[]) => mockGetStorageSamples(...(args as [])),
  getOperationsSamples: (...args: unknown[]) => mockGetOperationsSamples(...(args as [])),
  getTenantInfo: (...args: unknown[]) => mockGetTenantInfo(...(args as [])),
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

const mockGetAuroraS3Credentials = vi.fn();
const mockListObjects = vi.fn();

vi.mock('../lib/aurora-s3-client.js', () => ({
  getAuroraS3Credentials: (...args: unknown[]) => mockGetAuroraS3Credentials(...args),
  listObjects: (...args: unknown[]) => mockListObjects(...args),
}));

process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.com';
process.env.FILONE_STAGE = 'test';

const ddbMock = mockClient(DynamoDBClient);

import { handler } from './get-usage.js';
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SUB = 'auth0|abc123';
const MOCK_ORG_ID = 'org-1';
const MOCK_USER_ID = 'user-1';
const MOCK_EMAIL = 'user@example.com';
const AURORA_TENANT_ID = 'aurora-tenant-1';

function authenticatedEvent() {
  return buildEvent({
    cookies: ['hs_access_token=valid-token'],
    userInfo: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID, email: MOCK_EMAIL },
  });
}

function mockAuthIdentity() {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
    })
    .resolves({
      Item: {
        pk: { S: `SUB#${MOCK_SUB}` },
        sk: { S: 'IDENTITY' },
        userId: { S: MOCK_USER_ID },
        orgId: { S: MOCK_ORG_ID },
        email: { S: MOCK_EMAIL },
      },
    });

  ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
    })
    .resolves({
      Item: {
        pk: { S: `ORG#${MOCK_ORG_ID}` },
        sk: { S: 'PROFILE' },
        name: { S: 'Test Org' },
        orgConfirmed: { BOOL: true },
        auroraTenantId: { S: AURORA_TENANT_ID },
        setupStatus: { S: FINAL_SETUP_STATUS },
      },
    });
}

function mockAuthIdentityWithoutTenant() {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
    })
    .resolves({
      Item: {
        pk: { S: `SUB#${MOCK_SUB}` },
        sk: { S: 'IDENTITY' },
        userId: { S: MOCK_USER_ID },
        orgId: { S: MOCK_ORG_ID },
        email: { S: MOCK_EMAIL },
      },
    });

  ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
    })
    .resolves({
      Item: {
        pk: { S: `ORG#${MOCK_ORG_ID}` },
        sk: { S: 'PROFILE' },
        name: { S: 'Test Org' },
        orgConfirmed: { BOOL: true },
      },
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/usage handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    mockJwtVerify.mockResolvedValue({
      payload: { sub: MOCK_SUB, email: MOCK_EMAIL },
    });
    mockAuthIdentity();
    mockGetStorageSamples.mockResolvedValue([]);
    mockGetOperationsSamples.mockResolvedValue([]);
    mockGetTenantInfo.mockResolvedValue(null);
  });

  it('returns usage data from Aurora APIs', async () => {
    mockAuthIdentity();
    mockGetStorageSamples.mockResolvedValue([
      { timestamp: '2026-01-01T00:00:00Z', bytesUsed: 4000, objectCount: 3 },
    ]);
    mockGetOperationsSamples.mockResolvedValue([
      { timestamp: '2026-01-01T00:00:00Z', rxBytes: 1500 },
    ]);
    mockGetTenantInfo.mockResolvedValue({
      bucketCount: 2,
      bucketQuantityLimit: 50,
      keyCount: 3,
      accessKeyQuantityLimit: 200,
    });

    const result = await handler(authenticatedEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        storage: { usedBytes: 4000 },
        egress: { usedBytes: 1500 },
        buckets: { count: 2, limit: 50 },
        objects: { count: 3 },
        accessKeys: { count: 3, limit: 200 },
      }),
    });
  });

  it('returns zeros when auroraTenantId is missing', async () => {
    mockAuthIdentityWithoutTenant();

    const result = await handler(authenticatedEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        storage: { usedBytes: 0 },
        egress: { usedBytes: 0 },
        buckets: { count: 0, limit: 100 },
        objects: { count: 0 },
        accessKeys: { count: 0, limit: 300 },
      }),
    });
    expect(mockGetStorageSamples).not.toHaveBeenCalled();
    expect(mockGetOperationsSamples).not.toHaveBeenCalled();
    expect(mockGetTenantInfo).not.toHaveBeenCalled();
  });

  it('returns zeros when Aurora returns empty samples', async () => {
    mockAuthIdentity();

    const result = await handler(authenticatedEvent(), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        storage: { usedBytes: 0 },
        egress: { usedBytes: 0 },
        buckets: { count: 0, limit: 100 },
        objects: { count: 0 },
        accessKeys: { count: 0, limit: 300 },
      }),
    });
  });

  it('uses the last storage sample for aggregate values', async () => {
    mockAuthIdentity();
    mockGetStorageSamples.mockResolvedValue([
      { timestamp: '2026-01-01T00:00:00Z', bytesUsed: 1000, objectCount: 2 },
      { timestamp: '2026-01-15T00:00:00Z', bytesUsed: 5000, objectCount: 8 },
    ]);

    const result = await handler(authenticatedEvent(), buildContext());
    const body = JSON.parse(String((result as { body: string }).body));

    expect(body.storage.usedBytes).toBe(5000);
    expect(body.objects.count).toBe(8);
  });
});
