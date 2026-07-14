import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import type { ManagementApiClient } from './management-api-client.js';
import { ManagementApiConflictError } from './management-api-errors.js';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);
const ssmMock = mockClient(SSMClient);

const mockApiClient = {
  putTenant: vi.fn(),
  createAccessKey: vi.fn(),
  listAccessKeys: vi.fn(),
  deleteAccessKey: vi.fn(),
};

const client = mockApiClient as unknown as ManagementApiClient;

import { ensureTenantReady, CONSOLE_KEY_NAME } from './management-api-tenant-setup.js';

const orgId = '00000000-0000-0000-0000-000000000001';
const deps = { client, id: 'forge', stage: 'test', region: 'us-east-1' };
const ssmPath = `/filone/test/forge-s3/access-key/${orgId}`;

function profileItem(attrs: Record<string, string>) {
  return Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, { S: v }]));
}

function stubHappyPath() {
  ddbMock.on(GetItemCommand).resolves({ Item: profileItem({}) });
  ddbMock.on(UpdateItemCommand).resolves({});
  ssmMock.on(PutParameterCommand).resolves({});
  mockApiClient.putTenant.mockResolvedValue({
    tenantId: orgId,
    status: 'active',
    bucketCount: 0,
    bucketLimit: 100,
    accessKeyCount: 0,
    accessKeyLimit: 300,
    createdAt: '2026-01-01T00:00:00Z',
  });
  mockApiClient.createAccessKey.mockResolvedValue({
    accessKeyId: 'AKIATEST',
    secretAccessKey: 'SKTEST',
    name: CONSOLE_KEY_NAME,
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
  it('returns the stored tenantId without provisioning when the attribute is set', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: profileItem({ forgeTenantId: orgId }) });

    const result = await ensureTenantReady(deps, orgId);

    expect(result).toBe(orgId);
    expect(mockApiClient.putTenant).not.toHaveBeenCalled();
    // The read must be strongly consistent so a just-finished setup is seen.
    expect(ddbMock.commandCalls(GetItemCommand)[0].args[0].input.ConsistentRead).toBe(true);
  });

  it('provisions tenant, console key, SSM cred and PROFILE row on first run', async () => {
    stubHappyPath();

    const result = await ensureTenantReady(deps, orgId);

    expect(result).toBe(orgId);
    // tenantId is the orgId verbatim (client-supplied UUID).
    expect(mockApiClient.putTenant).toHaveBeenCalledWith(orgId, { region: 'us-east-1' });
    expect(mockApiClient.createAccessKey).toHaveBeenCalledWith(orgId, {
      name: CONSOLE_KEY_NAME,
      permissions: expect.arrayContaining(['s3:CreateBucket', 's3:GetObject', 's3:PutObject']),
      buckets: [],
      expiresAt: null,
    });

    const putCalls = ssmMock.commandCalls(PutParameterCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input).toMatchObject({
      Name: ssmPath,
      Type: 'SecureString',
      Overwrite: true,
      Value: JSON.stringify({ accessKeyId: 'AKIATEST', secretAccessKey: 'SKTEST' }),
    });

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.UpdateExpression).toContain('forgeTenantId');
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues).toMatchObject({
      ':tenantId': { S: orgId },
    });
  });

  it('requests only s3:* actions from the contract enum for the console key', async () => {
    stubHappyPath();

    await ensureTenantReady(deps, orgId);

    const { permissions } = mockApiClient.createAccessKey.mock.calls[0][1];
    expect(permissions).toHaveLength(14);
    // The contract enum (unlike FTH) has no bucket-config actions.
    expect(permissions).not.toContain('s3:GetBucketVersioning');
    expect(permissions).not.toContain('s3:PutBucketVersioning');
    expect(permissions).not.toContain('s3:GetBucketObjectLockConfiguration');
    expect(permissions).not.toContain('s3:PutBucketObjectLockConfiguration');
  });

  describe('409 recovery (crash between key creation and SSM write)', () => {
    function stubConflictThenList(existingAccessKeyId: string | null) {
      stubHappyPath();
      mockApiClient.createAccessKey
        .mockRejectedValueOnce(new ManagementApiConflictError('duplicate', undefined))
        .mockResolvedValue({
          accessKeyId: 'AKIAFRESH',
          secretAccessKey: 'SKFRESH',
          name: CONSOLE_KEY_NAME,
          permissions: [],
          buckets: [],
          createdAt: '2026-01-02T00:00:00Z',
        });
      mockApiClient.listAccessKeys.mockResolvedValue(
        existingAccessKeyId
          ? [
              {
                accessKeyId: existingAccessKeyId,
                name: CONSOLE_KEY_NAME,
                permissions: [],
                createdAt: '2026-01-01T00:00:00Z',
              },
            ]
          : [],
      );
      mockApiClient.deleteAccessKey.mockResolvedValue(undefined);
    }

    it('reuses the existing key when SSM already holds its credentials', async () => {
      stubConflictThenList('AKIAOLD');
      ssmMock.on(GetParameterCommand).resolves({
        Parameter: { Value: JSON.stringify({ accessKeyId: 'AKIAOLD', secretAccessKey: 'SKOLD' }) },
      });

      const result = await ensureTenantReady(deps, orgId);

      expect(result).toBe(orgId);
      expect(mockApiClient.deleteAccessKey).not.toHaveBeenCalled();
      expect(mockApiClient.createAccessKey).toHaveBeenCalledTimes(1);
      // Nothing to restock: the previous run completed the SSM write.
      expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
    });

    it('rotates the key when SSM has no credentials for it', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      stubConflictThenList('AKIAOLD');
      const notFound = new Error('not found');
      notFound.name = 'ParameterNotFound';
      ssmMock.on(GetParameterCommand).rejects(notFound);

      const result = await ensureTenantReady(deps, orgId);

      expect(result).toBe(orgId);
      expect(mockApiClient.deleteAccessKey).toHaveBeenCalledWith(orgId, 'AKIAOLD');
      expect(mockApiClient.createAccessKey).toHaveBeenCalledTimes(2);
      const putCalls = ssmMock.commandCalls(PutParameterCommand);
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0].args[0].input.Value).toBe(
        JSON.stringify({ accessKeyId: 'AKIAFRESH', secretAccessKey: 'SKFRESH' }),
      );
    });

    it('rotates the key when SSM holds stale credentials for a different key', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      stubConflictThenList('AKIAOLD');
      ssmMock.on(GetParameterCommand).resolves({
        Parameter: {
          Value: JSON.stringify({ accessKeyId: 'AKIASTALE', secretAccessKey: 'SKSTALE' }),
        },
      });

      const result = await ensureTenantReady(deps, orgId);

      expect(result).toBe(orgId);
      expect(mockApiClient.deleteAccessKey).toHaveBeenCalledWith(orgId, 'AKIAOLD');
      expect(mockApiClient.createAccessKey).toHaveBeenCalledTimes(2);
    });

    it('fails (returns null) when the 409 name is absent from the key listing', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      stubConflictThenList(null);

      const result = await ensureTenantReady(deps, orgId);

      expect(result).toBeNull();
      expect(mockApiClient.deleteAccessKey).not.toHaveBeenCalled();
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });
  });

  it('returns null and skips the DDB write when a setup step throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubHappyPath();
    ssmMock.on(PutParameterCommand).rejects(new Error('SSM is down'));

    const result = await ensureTenantReady(deps, orgId);

    expect(result).toBeNull();
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('logs failures with the orchestrator id, without leaking the secret', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    stubHappyPath();
    ssmMock.on(PutParameterCommand).rejects(new Error('SSM is down'));

    await ensureTenantReady(deps, orgId);

    expect(errorSpy).toHaveBeenCalledWith(
      '[management-api-tenant-setup] setup failed',
      expect.objectContaining({
        orchestratorId: 'forge',
        orgId,
        error: expect.stringContaining('SSM is down'),
      }),
    );
    for (const call of [...errorSpy.mock.calls, ...logSpy.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain('SKTEST');
    }
  });
});
