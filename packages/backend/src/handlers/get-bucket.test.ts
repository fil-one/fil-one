import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { FINAL_SETUP_STATUS } from '../lib/org-setup-status.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockGetAuroraPortalApiKey = vi.fn();
vi.mock('../lib/aurora-portal.js', () => ({
  getAuroraPortalApiKey: (...args: unknown[]) => mockGetAuroraPortalApiKey(...args),
}));

const mockGetBucket = vi.fn();
vi.mock('@filone/aurora-portal-client', () => ({
  createClient: () => 'mock-client',
  getBucketInfo: (...args: unknown[]) => mockGetBucket(...args),
}));

process.env.AURORA_PORTAL_URL = 'https://portal.dev.aur.lu';
process.env.FILONE_STAGE = 'test';

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './get-bucket.js';
import { buildEvent } from '../test/lambda-test-utilities.js';
import { S3_REGION } from '@filone/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('get-bucket baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('returns 200 with bucket data from Aurora', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraPortalApiKey.mockResolvedValue('test-api-key');
    mockGetBucket.mockResolvedValue({
      data: { name: 'my-bucket', createdAt: '2026-01-15T10:00:00Z' },
      error: undefined,
      response: { status: 200 },
    });

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({
      bucket: {
        name: 'my-bucket',
        region: S3_REGION,
        createdAt: '2026-01-15T10:00:00Z',
        isPublic: false,
        objectLockEnabled: false,
        versioning: false,
        encrypted: true,
      },
    });
  });

  it('returns objectLockEnabled true when Aurora reports objectLock', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraPortalApiKey.mockResolvedValue('test-api-key');
    mockGetBucket.mockResolvedValue({
      data: { name: 'locked-bucket', createdAt: '2026-01-15T10:00:00Z', objectLock: true },
      error: undefined,
      response: { status: 200 },
    });

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'locked-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({
      bucket: {
        name: 'locked-bucket',
        region: S3_REGION,
        createdAt: '2026-01-15T10:00:00Z',
        isPublic: false,
        objectLockEnabled: true,
        versioning: false,
        encrypted: true,
      },
    });
  });

  it('returns objectLockEnabled true when Aurora reports objectLock', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraPortalApiKey.mockResolvedValue('test-api-key');
    mockGetBucket.mockResolvedValue({
      data: { name: 'locked-bucket', createdAt: '2026-01-15T10:00:00Z', objectLock: true },
      error: undefined,
      response: { status: 200 },
    });

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'locked-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({
      bucket: {
        name: 'locked-bucket',
        region: S3_REGION,
        createdAt: '2026-01-15T10:00:00Z',
        isPublic: false,
        objectLockEnabled: true,
        versioning: false,
        encrypted: true,
      },
    });
  });

  it('passes through versioning, encryption, and retention fields', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraPortalApiKey.mockResolvedValue('test-api-key');
    mockGetBucket.mockResolvedValue({
      data: {
        name: 'full-bucket',
        createdAt: '2026-01-15T10:00:00Z',
        objectLock: true,
        versioning: true,
        encrypted: true,
        defaultRetention: 'compliance',
        retentionDuration: 365,
        retentionDurationType: 'd',
      },
      error: undefined,
      response: { status: 200 },
    });

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'full-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({
      bucket: {
        name: 'full-bucket',
        region: S3_REGION,
        createdAt: '2026-01-15T10:00:00Z',
        isPublic: false,
        objectLockEnabled: true,
        versioning: true,
        encrypted: true,
        defaultRetention: 'compliance',
        retentionDuration: 365,
        retentionDurationType: 'd',
      },
    });
  });

  it('maps defaultRetention "off" to undefined', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraPortalApiKey.mockResolvedValue('test-api-key');
    mockGetBucket.mockResolvedValue({
      data: {
        name: 'no-retention',
        createdAt: '2026-01-15T10:00:00Z',
        defaultRetention: 'off',
        retentionDuration: 0,
        retentionDurationType: 'd',
      },
      error: undefined,
      response: { status: 200 },
    });

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'no-retention' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body!);
    expect(body.bucket.defaultRetention).toBeUndefined();
  });

  it('calls Aurora portal API with correct params', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraPortalApiKey.mockResolvedValue('test-api-key');
    mockGetBucket.mockResolvedValue({
      data: { name: 'my-bucket', createdAt: '2026-01-15T10:00:00Z' },
      error: undefined,
      response: { status: 200 },
    });

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    await baseHandler(event);

    expect(mockGetAuroraPortalApiKey).toHaveBeenCalledWith('test', 'aurora-t-1');
    expect(mockGetBucket).toHaveBeenCalledWith({
      client: 'mock-client',
      path: { tenantId: 'aurora-t-1', bucketName: 'my-bucket' },
      throwOnError: false,
    });
  });

  it('returns 404 when Aurora returns 404', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraPortalApiKey.mockResolvedValue('test-api-key');
    mockGetBucket.mockResolvedValue({
      data: undefined,
      error: { message: 'Not found' },
      response: { status: 404 },
    });

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'nonexistent-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(404);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({ message: 'Bucket not found' });
  });

  it('throws when Aurora returns a non-404 error', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraPortalApiKey.mockResolvedValue('test-api-key');
    mockGetBucket.mockResolvedValue({
      data: undefined,
      error: { message: 'Internal error' },
      response: { status: 500 },
    });

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };

    await expect(baseHandler(event)).rejects.toThrow(
      'Failed to get bucket "my-bucket" from Aurora for tenant aurora-t-1',
    );
  });

  it('returns 400 when bucket name is missing', async () => {
    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

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

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    expect(mockGetBucket).not.toHaveBeenCalled();
  });

  it('returns 503 when org setup is not complete', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        pk: { S: `ORG#${USER_INFO.orgId}` },
        sk: { S: 'PROFILE' },
        auroraTenantId: { S: 'aurora-t-1' },
        setupStatus: { S: 'AURORA_TENANT_SETUP_COMPLETE' },
      },
    });

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    expect(mockGetBucket).not.toHaveBeenCalled();
  });
});
