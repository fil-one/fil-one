import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { FINAL_SETUP_STATUS } from '../lib/org-setup-status.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UploadsTable: { name: 'UploadsTable' },
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockCreateAuroraBucket = vi.fn();

vi.mock('../lib/aurora-portal.js', () => ({
  createAuroraBucket: (...args: unknown[]) => mockCreateAuroraBucket(...args),
}));

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './create-bucket.js';
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
    ddbMock.on(PutItemCommand).resolves({});
    mockCreateAuroraBucket.mockResolvedValue(undefined);

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(201);
    expect(mockCreateAuroraBucket).toHaveBeenCalledWith({
      tenantId: 'aurora-t-1',
      bucketName: 'my-bucket',
    });
  });

  it('returns 503 when auroraTenantId is missing', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithoutTenant());

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    expect(mockCreateAuroraBucket).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
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
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });

  it('throws when Aurora Portal API fails', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockCreateAuroraBucket.mockRejectedValue(new Error('Aurora API error'));

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });

    await expect(baseHandler(event)).rejects.toThrow('Aurora API error');
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });

  it('returns 409 when DynamoDB bucket already exists', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    ddbMock.on(PutItemCommand).rejects(
      Object.assign(new Error('Conditional check failed'), {
        name: 'ConditionalCheckFailedException',
      }),
    );
    mockCreateAuroraBucket.mockResolvedValue(undefined);

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(409);
  });

  it('calls Aurora before DynamoDB PutItem', async () => {
    const callOrder: string[] = [];

    mockCreateAuroraBucket.mockImplementation(async () => {
      callOrder.push('aurora');
    });
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    ddbMock.on(PutItemCommand).callsFake(() => {
      callOrder.push('dynamodb-put');
      return {};
    });

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    await baseHandler(event);

    expect(callOrder).toStrictEqual(['aurora', 'dynamodb-put']);
  });
});
