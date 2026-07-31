import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { FthConflictError } from './fth-management-client.js';
import type { FthManagementClient } from './fth-management-client.js';

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
  listAccessKeys: vi.fn(),
  deleteAccessKey: vi.fn(),
  listStorageUsers: vi.fn(),
};

const fthClient = mockFthClient as unknown as FthManagementClient;

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

    const result = await ensureTenantReady(fthClient, orgId);

    expect(result).toBe(fthClientId);
    expect(mockFthClient.createClient).not.toHaveBeenCalled();
  });

  it('creates client, storage user, access key, SSM cred and PROFILE row on first run', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: profileItem({}) });
    ddbMock.on(UpdateItemCommand).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    stubSetupApiCalls();

    const result = await ensureTenantReady(fthClient, orgId);

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

  describe('when creating the console key conflicts', () => {
    const conflict = () =>
      new FthConflictError('access key name already in use', { message: 'duplicate' });

    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      ddbMock.on(GetItemCommand).resolves({ Item: profileItem({}) });
      ddbMock.on(UpdateItemCommand).resolves({});
      ssmMock.on(PutParameterCommand).resolves({});
      stubSetupApiCalls();
    });

    it('deletes the stale key and re-creates it under a unique idempotency key', async () => {
      mockFthClient.createAccessKey.mockRejectedValueOnce(conflict()).mockResolvedValueOnce({
        accessKeyId: 'AKIAFRESH',
        secretAccessKey: 'SKFRESH',
        name: 'filone-console',
        permissions: [],
        buckets: [],
        createdAt: '2026-01-01T00:00:00Z',
      });
      mockFthClient.listAccessKeys.mockResolvedValue([
        {
          accessKeyId: 'AKIASTALE',
          name: 'filone-console',
          permissions: [],
          buckets: [],
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          accessKeyId: 'AKIAOTHER',
          name: 'some-user-key',
          permissions: [],
          buckets: [],
          createdAt: '2026-01-01T00:00:00Z',
        },
      ]);
      mockFthClient.deleteAccessKey.mockResolvedValue(undefined);

      const result = await ensureTenantReady(fthClient, orgId);

      expect(result).toBe(fthClientId);
      expect(mockFthClient.listAccessKeys).toHaveBeenCalledWith(fthClientId);
      // Only the console key is revoked; the tenant's own keys are untouched.
      expect(mockFthClient.deleteAccessKey).toHaveBeenCalledTimes(1);
      expect(mockFthClient.deleteAccessKey).toHaveBeenCalledWith(
        fthClientId,
        'AKIASTALE',
        expect.objectContaining({ idempotencyKey: `${orgId}-console-key-delete-AKIASTALE` }),
      );

      expect(mockFthClient.createAccessKey).toHaveBeenCalledTimes(2);
      const [firstKey, secondKey] = mockFthClient.createAccessKey.mock.calls.map(
        (call) => (call[2] as { idempotencyKey: string }).idempotencyKey,
      );
      expect(firstKey).toBe(`${orgId}-console-key`);
      expect(secondKey).not.toBe(firstKey);
      expect(secondKey).toMatch(new RegExp(`^${orgId}-console-key-.+`));

      // SSM gets the fresh secret, not the unrecoverable stale one.
      const putCalls = ssmMock.commandCalls(PutParameterCommand);
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0].args[0].input.Value).toBe(
        JSON.stringify({ accessKeyId: 'AKIAFRESH', secretAccessKey: 'SKFRESH' }),
      );
    });

    it('deletes every console key when the listing has more than one', async () => {
      mockFthClient.createAccessKey.mockRejectedValueOnce(conflict()).mockResolvedValueOnce({
        accessKeyId: 'AKIAFRESH',
        secretAccessKey: 'SKFRESH',
        name: 'filone-console',
        permissions: [],
        buckets: [],
        createdAt: '2026-01-01T00:00:00Z',
      });
      mockFthClient.listAccessKeys.mockResolvedValue([
        {
          accessKeyId: 'AKIAA',
          name: 'filone-console',
          permissions: [],
          buckets: [],
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          accessKeyId: 'AKIAB',
          name: 'filone-console',
          permissions: [],
          buckets: [],
          createdAt: '2026-01-01T00:00:00Z',
        },
      ]);
      mockFthClient.deleteAccessKey.mockResolvedValue(undefined);

      await ensureTenantReady(fthClient, orgId);

      expect(mockFthClient.deleteAccessKey.mock.calls.map((c) => c[1])).toEqual(['AKIAA', 'AKIAB']);
    });

    it('fails when the conflicting key is absent from the listing', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mockFthClient.createAccessKey.mockRejectedValueOnce(conflict());
      mockFthClient.listAccessKeys.mockResolvedValue([]);

      const result = await ensureTenantReady(fthClient, orgId);

      expect(result).toBeNull();
      expect(mockFthClient.deleteAccessKey).not.toHaveBeenCalled();
      expect(mockFthClient.createAccessKey).toHaveBeenCalledTimes(1);
    });

    it('does not rotate on non-conflict errors', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mockFthClient.createAccessKey.mockRejectedValueOnce(new Error('boom'));

      const result = await ensureTenantReady(fthClient, orgId);

      expect(result).toBeNull();
      expect(mockFthClient.listAccessKeys).not.toHaveBeenCalled();
      expect(mockFthClient.deleteAccessKey).not.toHaveBeenCalled();
    });
  });

  it('returns null when setup throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ddbMock.on(GetItemCommand).rejects(new Error('DDB is down'));

    const result = await ensureTenantReady(fthClient, orgId);

    expect(result).toBeNull();
  });

  it('logs the error to console.error when setup throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    ddbMock.on(GetItemCommand).rejects(new Error('DDB is down'));

    await ensureTenantReady(fthClient, orgId);

    expect(errorSpy).toHaveBeenCalledWith(
      '[fth-tenant-setup] setup failed',
      expect.objectContaining({ orgId, error: expect.stringContaining('DDB is down') }),
    );
  });
});
