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

const mockListBuckets = vi.fn();
vi.mock('@filone/aurora-portal-client', () => ({
  createClient: () => 'mock-client',
  listBuckets: (...args: unknown[]) => mockListBuckets(...args),
}));

process.env.AURORA_PORTAL_URL = 'https://portal.dev.aur.lu';
process.env.FILONE_STAGE = 'test';

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './list-buckets.js';
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

describe('list-buckets baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('returns 200 with buckets from Aurora Portal', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraPortalApiKey.mockResolvedValue('test-api-key');
    mockListBuckets.mockResolvedValue({
      data: {
        items: [
          { name: 'my-bucket', createdAt: '2026-01-01T00:00:00.000Z' },
          { name: 'other-bucket', createdAt: '2026-01-02T00:00:00.000Z' },
        ],
      },
      error: undefined,
    });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body).toStrictEqual({
      buckets: [
        {
          name: 'my-bucket',
          region: S3_REGION,
          createdAt: '2026-01-01T00:00:00.000Z',
          isPublic: false,
        },
        {
          name: 'other-bucket',
          region: S3_REGION,
          createdAt: '2026-01-02T00:00:00.000Z',
          isPublic: false,
        },
      ],
    });
  });

  it('calls Aurora Portal API with correct params', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraPortalApiKey.mockResolvedValue('test-api-key');
    mockListBuckets.mockResolvedValue({
      data: { items: [] },
      error: undefined,
    });

    const event = buildEvent({ userInfo: USER_INFO });
    await baseHandler(event);

    expect(mockGetAuroraPortalApiKey).toHaveBeenCalledWith('test', 'aurora-t-1');
    expect(mockListBuckets).toHaveBeenCalledWith({
      client: 'mock-client',
      path: { tenantId: 'aurora-t-1' },
      throwOnError: false,
    });
  });

  it('throws when Aurora returns an error', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraPortalApiKey.mockResolvedValue('test-api-key');
    mockListBuckets.mockResolvedValue({
      data: undefined,
      error: { message: 'Internal error' },
    });

    const event = buildEvent({ userInfo: USER_INFO });

    await expect(baseHandler(event)).rejects.toThrow(
      'Failed to list buckets from Aurora for tenant aurora-t-1',
    );
  });

  it('returns 503 when auroraTenantId is missing', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        pk: { S: `ORG#${USER_INFO.orgId}` },
        sk: { S: 'PROFILE' },
      },
    });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    expect(mockListBuckets).not.toHaveBeenCalled();
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
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    expect(mockListBuckets).not.toHaveBeenCalled();
  });

  it('returns 200 with empty array when no buckets exist', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraPortalApiKey.mockResolvedValue('test-api-key');
    mockListBuckets.mockResolvedValue({
      data: { items: [] },
      error: undefined,
    });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body).toStrictEqual({ buckets: [] });
  });
});
