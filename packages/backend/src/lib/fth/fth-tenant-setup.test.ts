import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    FthManagementApiToken: { value: 'kid.secret' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);
const ssmMock = mockClient(SSMClient);

const mockFthClient = {
  createClient: vi.fn(),
  createStorageUser: vi.fn(),
  createAccessKey: vi.fn(),
};

vi.mock('./fth-management-client.js', () => ({
  createFthManagementClient: vi.fn(() => mockFthClient),
}));

vi.mock('./fth-api-metrics.js', () => ({
  instrumentClient: vi.fn(),
}));

process.env.FILONE_STAGE = 'test';
process.env.FTH_MANAGEMENT_API_URL = 'https://api.fortilyx.test';

import { ensureTenantReady } from './fth-tenant-setup.js';

const orgId = '00000000-0000-0000-0000-000000000001';
const fthClientId = '42';
const serviceUserId = '7';

function profileItem(attrs: Record<string, string>) {
  return Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, { S: v }]));
}

function stubSetupApiCalls() {
  mockFthClient.createClient.mockResolvedValue({
    id: fthClientId,
    externalId: orgId,
    displayName: `FilOne test ${orgId}`,
    createdAt: '2026-01-01T00:00:00Z',
  });
  mockFthClient.createStorageUser.mockResolvedValue({
    id: serviceUserId,
    userCode: 'filone-console',
    displayName: 'FilOne Console User',
    email: `console-test-${fthClientId}@filone.internal`,
    role: 'storage_user',
    createdAt: '2026-01-01T00:00:00Z',
  });
  mockFthClient.createAccessKey.mockResolvedValue({
    accessKeyId: 'AKIATEST',
    secretAccessKey: 'SKTEST',
    name: 'filone-console',
    permissions: [],
    buckets: [],
    createdAt: '2026-01-01T00:00:00Z',
  });
}

beforeEach(() => {
  ddbMock.reset();
  ssmMock.reset();
  vi.clearAllMocks();
});

describe('ensureTenantReady', () => {
  it('returns the existing fthTenantId when one is already set', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: profileItem({ fthTenantId: fthClientId }),
    });

    const result = await ensureTenantReady(orgId);

    expect(result).toBe(fthClientId);
    expect(mockFthClient.createClient).not.toHaveBeenCalled();
  });

  it('creates client, storage user, access key, SSM cred and PROFILE row on first run', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: profileItem({}) });
    ddbMock.on(UpdateItemCommand).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    stubSetupApiCalls();

    const result = await ensureTenantReady(orgId);

    expect(result).toBe(fthClientId);
    expect(mockFthClient.createClient).toHaveBeenCalledWith({
      externalId: orgId,
      displayName: `FilOne test ${orgId}`,
      idempotencyKey: orgId,
    });
    expect(mockFthClient.createStorageUser).toHaveBeenCalledWith(
      fthClientId,
      expect.objectContaining({
        email: `console-test-${fthClientId}@filone.internal`,
        userCode: 'filone-console',
        role: 'storage_user',
        issueS3Credentials: false,
        idempotencyKey: `console-test-${fthClientId}`,
      }),
    );
    expect(mockFthClient.createAccessKey).toHaveBeenCalledWith(
      fthClientId,
      serviceUserId,
      expect.objectContaining({
        name: 'filone-console',
        idempotencyKey: `${orgId}-console-key`,
      }),
    );

    const putCalls = ssmMock.commandCalls(PutParameterCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input).toMatchObject({
      Name: `/filone/test/fth-s3/access-key/${fthClientId}`,
      Type: 'SecureString',
      Value: JSON.stringify({ accessKeyId: 'AKIATEST', secretAccessKey: 'SKTEST' }),
    });

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues).toMatchObject({
      ':tenantId': { S: fthClientId },
    });
  });

  it('returns null when setup throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ddbMock.on(GetItemCommand).rejects(new Error('DDB is down'));

    const result = await ensureTenantReady(orgId);

    expect(result).toBeNull();
  });

  it('logs the error to console.error when setup throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    ddbMock.on(GetItemCommand).rejects(new Error('DDB is down'));

    await ensureTenantReady(orgId);

    expect(errorSpy).toHaveBeenCalledWith(
      '[fth-tenant-setup] setup failed',
      expect.objectContaining({ orgId, error: expect.stringContaining('DDB is down') }),
    );
  });
});
