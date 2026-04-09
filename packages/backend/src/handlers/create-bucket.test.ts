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

const mockCreateAuroraBucket = vi.fn();

vi.mock('../lib/aurora-portal.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/aurora-portal.js')>();
  return {
    ...original,
    createAuroraBucket: (...args: unknown[]) => mockCreateAuroraBucket(...args),
  };
});

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './create-bucket.js';
import { BucketAlreadyExistsError } from '../lib/aurora-portal.js';
import { buildEvent } from '../test/lambda-test-utilities.js';
import { S3_REGION } from '@filone/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

function validBody() {
  return JSON.stringify({ name: 'my-bucket', region: S3_REGION });
}

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

function orgProfileWithoutTenant() {
  return {
    Item: {
      pk: { S: `ORG#${USER_INFO.orgId}` },
      sk: { S: 'PROFILE' },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('create-bucket baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('returns 201 and calls createAuroraBucket on success', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockCreateAuroraBucket.mockResolvedValue(undefined);

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(201);
    expect(mockCreateAuroraBucket).toHaveBeenCalledWith({
      tenantId: 'aurora-t-1',
      bucketName: 'my-bucket',
      versioning: false,
      lock: false,
      retention: undefined,
    });
  });

  it('returns 503 when auroraTenantId is missing', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithoutTenant());

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    expect(mockCreateAuroraBucket).not.toHaveBeenCalled();
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

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    expect(mockCreateAuroraBucket).not.toHaveBeenCalled();
  });

  it('throws when Aurora Portal API fails', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockCreateAuroraBucket.mockRejectedValue(new Error('Aurora API error'));

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });

    await expect(baseHandler(event)).rejects.toThrow('Aurora API error');
  });

  it('returns 409 when Aurora bucket already exists', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockCreateAuroraBucket.mockRejectedValue(new BucketAlreadyExistsError('my-bucket'));

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(409);
  });

  it('passes versioning, lock, and retention to createAuroraBucket', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockCreateAuroraBucket.mockResolvedValue(undefined);

    const event = buildEvent({
      body: JSON.stringify({
        name: 'my-bucket',
        region: S3_REGION,
        versioning: true,
        lock: true,
        retention: { enabled: true, mode: 'governance', duration: 30, durationType: 'd' },
      }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(201);
    expect(mockCreateAuroraBucket).toHaveBeenCalledWith({
      tenantId: 'aurora-t-1',
      bucketName: 'my-bucket',
      versioning: true,
      lock: true,
      retention: { enabled: true, mode: 'governance', duration: 30, durationType: 'd' },
    });
  });

  it('defaults versioning and lock to false when not provided', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockCreateAuroraBucket.mockResolvedValue(undefined);

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(201);
    expect(mockCreateAuroraBucket).toHaveBeenCalledWith({
      tenantId: 'aurora-t-1',
      bucketName: 'my-bucket',
      versioning: false,
      lock: false,
      retention: undefined,
    });
  });

  it('returns 400 when lock is true but versioning is false', async () => {
    const event = buildEvent({
      body: JSON.stringify({ name: 'my-bucket', region: S3_REGION, lock: true }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body as string);
    expect(body.message).toContain('Versioning must be enabled');
    expect(mockCreateAuroraBucket).not.toHaveBeenCalled();
  });

  it('returns 400 when retention is provided without lock', async () => {
    const event = buildEvent({
      body: JSON.stringify({
        name: 'my-bucket',
        region: S3_REGION,
        versioning: true,
        retention: { enabled: true, mode: 'governance', duration: 30, durationType: 'd' },
      }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body as string);
    expect(body.message).toContain('Object Lock must be enabled');
    expect(mockCreateAuroraBucket).not.toHaveBeenCalled();
  });

  it('returns 400 when region is unsupported', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));

    const event = buildEvent({
      body: JSON.stringify({ name: 'my-bucket', region: 'us-west-2' }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body as string);
    expect(body.message).toContain('Unsupported region');
    expect(mockCreateAuroraBucket).not.toHaveBeenCalled();
  });
});
