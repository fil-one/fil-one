import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import type { Client } from '@filone/orchestrator-client';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

// The generated SDK functions are mocked at the module boundary; each returns
// the hey-api result shape `{ data, error, response }` the setup code branches on.
const mockPutTenant = vi.fn((_options: Record<string, unknown>) => ({}));
const mockCreateAccessKey = vi.fn((_options: Record<string, unknown>) => ({}));
const mockListAccessKeys = vi.fn((_options: Record<string, unknown>) => ({}));
const mockDeleteAccessKey = vi.fn((_options: Record<string, unknown>) => ({}));
const mockDeleteTenant = vi.fn((_options: Record<string, unknown>) => ({}));

vi.mock('@filone/orchestrator-client', () => ({
  putTenantsByTenantId: (options: Record<string, unknown>) => mockPutTenant(options),
  postTenantsByTenantIdAccessKeys: (options: Record<string, unknown>) =>
    mockCreateAccessKey(options),
  getTenantsByTenantIdAccessKeys: (options: Record<string, unknown>) => mockListAccessKeys(options),
  deleteTenantsByTenantIdAccessKeysByAccessKeyId: (options: Record<string, unknown>) =>
    mockDeleteAccessKey(options),
  deleteTenantsByTenantId: (options: Record<string, unknown>) => mockDeleteTenant(options),
}));

const ddbMock = mockClient(DynamoDBClient);
const ssmMock = mockClient(SSMClient);

// SDK calls are module-mocked, so the client value is just forwarded — a sentinel is enough.
const client = 'mock-management-client' as unknown as Client;

import { ensureTenantReady, CONSOLE_KEY_NAME } from './tenant-setup.js';
import { OrgDeletingError } from '../org-profile.js';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';

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
  mockPutTenant.mockResolvedValue({
    data: {
      tenantId: orgId,
      status: 'active',
      bucketCount: 0,
      bucketLimit: 100,
      accessKeyCount: 0,
      accessKeyLimit: 300,
      createdAt: '2026-01-01T00:00:00Z',
    },
    error: undefined,
    response: { status: 201 },
  });
  mockCreateAccessKey.mockResolvedValue({
    data: {
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'SKTEST',
      name: CONSOLE_KEY_NAME,
      permissions: [],
      buckets: [],
      createdAt: '2026-01-01T00:00:00Z',
    },
    error: undefined,
    response: { status: 201 },
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
    expect(mockPutTenant).not.toHaveBeenCalled();
    // The read must be strongly consistent so a just-finished setup is seen.
    expect(ddbMock.commandCalls(GetItemCommand)[0].args[0].input.ConsistentRead).toBe(true);
  });

  // Before any upstream call: refusing only the final pointer write would
  // leave the tenant, its console key and its SSM secret orphaned.
  it('refuses a deleting org without provisioning anything', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: { ...profileItem({}), deleting: { BOOL: true } } });

    await expect(ensureTenantReady(deps, orgId)).rejects.toBeInstanceOf(OrgDeletingError);
    expect(mockPutTenant).not.toHaveBeenCalled();
    expect(mockCreateAccessKey).not.toHaveBeenCalled();
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
  });

  it('conditions the pointer write so it cannot resurrect a purged profile', async () => {
    stubHappyPath();

    await ensureTenantReady(deps, orgId);

    expect(ddbMock.commandCalls(UpdateItemCommand)[0].args[0].input.ConditionExpression).toBe(
      'attribute_exists(pk) AND attribute_not_exists(deleting)',
    );
  });

  // The deferred risk: this request read the profile before the fence landed, so
  // it created a tenant upstream that will never get a local pointer.
  describe('when the fence lands mid-setup', () => {
    function refuseWith(item?: Record<string, unknown>) {
      ddbMock.on(UpdateItemCommand).rejects(
        new ConditionalCheckFailedException({
          message: 'refused',
          $metadata: {},
          Item: item,
        } as never),
      );
    }

    it('deletes the orphaned tenant and refuses, rather than answering 503', async () => {
      stubHappyPath();
      refuseWith({ deleting: { BOOL: true } });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await expect(ensureTenantReady(deps, orgId)).rejects.toBeInstanceOf(OrgDeletingError);
        expect(mockDeleteTenant).toHaveBeenCalledWith(
          expect.objectContaining({ path: { tenantId: orgId } }),
        );
      } finally {
        warn.mockRestore();
      }
    });

    // The condition names no tenant-id attribute, so a concurrent writer cannot
    // refuse this write. A refusal carrying no item means no profile row, and
    // reporting the tenant ready would hide one nothing recorded.
    it('deletes the orphaned tenant and refuses when the profile is missing', async () => {
      stubHappyPath();
      refuseWith(undefined);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        // null, not the tenantId: the caller answers 503 instead of creating
        // buckets against a tenant nothing recorded.
        await expect(ensureTenantReady(deps, orgId)).resolves.toBeNull();
        expect(mockDeleteTenant).toHaveBeenCalledWith(
          expect.objectContaining({ path: { tenantId: orgId } }),
        );
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }
    });

    // A failed rollback must not turn the refusal into "try again in a moment".
    it('still refuses when the tenant cannot be deleted', async () => {
      stubHappyPath();
      refuseWith({ deleting: { BOOL: true } });
      mockDeleteTenant.mockReturnValue({ error: { message: 'no tenant DELETE yet' } });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await expect(ensureTenantReady(deps, orgId)).rejects.toBeInstanceOf(OrgDeletingError);
        expect(error).toHaveBeenCalled();
      } finally {
        error.mockRestore();
      }
    });
  });

  it('provisions tenant, console key, SSM cred and PROFILE row on first run', async () => {
    stubHappyPath();

    const result = await ensureTenantReady(deps, orgId);

    expect(result).toBe(orgId);
    // tenantId is the orgId verbatim (client-supplied UUID).
    expect(mockPutTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        path: { tenantId: orgId },
        body: { region: 'us-east-1' },
        throwOnError: false,
      }),
    );
    expect(mockCreateAccessKey).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        path: { tenantId: orgId },
        body: expect.objectContaining({
          name: CONSOLE_KEY_NAME,
          permissions: expect.arrayContaining(['s3:CreateBucket', 's3:GetObject', 's3:PutObject']),
          buckets: [],
          expiresAt: null,
        }),
        throwOnError: false,
      }),
    );

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
    expect(updateCalls[0].args[0].input.UpdateExpression).toContain('#tenantIdAttr');
    expect(updateCalls[0].args[0].input.UpdateExpression).toContain(':tenantId');
    expect(updateCalls[0].args[0].input.ExpressionAttributeNames).toMatchObject({
      '#tenantIdAttr': 'forgeTenantId',
    });
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues).toMatchObject({
      ':tenantId': { S: orgId },
    });
  });

  it('scopes the SSM path and PROFILE attribute per id', async () => {
    // Region-encoded ids (multi-region Forge) must not collide across regions and
    // must produce a valid hyphenated DynamoDB attribute name via ExpressionAttributeNames.
    const regionDeps = { ...deps, id: 'forge' };
    stubHappyPath();

    const result = await ensureTenantReady(regionDeps, orgId);

    expect(result).toBe(orgId);
    expect(ssmMock.commandCalls(PutParameterCommand)[0].args[0].input.Name).toBe(
      `/filone/test/forge-s3/access-key/${orgId}`,
    );
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls[0].args[0].input.ExpressionAttributeNames).toMatchObject({
      '#tenantIdAttr': 'forgeTenantId',
    });
  });

  it('requests only s3:* actions from the contract enum for the console key', async () => {
    stubHappyPath();

    await ensureTenantReady(deps, orgId);

    const { permissions } = mockCreateAccessKey.mock.calls[0][0].body as { permissions: string[] };
    expect(permissions).toHaveLength(15);
    expect(permissions).toContain('s3:ListBucketMultipartUploads');
    // The contract enum (unlike FTH) has no bucket-config actions.
    expect(permissions).not.toContain('s3:GetBucketVersioning');
    expect(permissions).not.toContain('s3:PutBucketVersioning');
    expect(permissions).not.toContain('s3:GetBucketObjectLockConfiguration');
    expect(permissions).not.toContain('s3:PutBucketObjectLockConfiguration');
  });

  describe('409 recovery (crash between key creation and SSM write)', () => {
    function stubConflictThenList(existingAccessKeyId: string | null) {
      stubHappyPath();
      mockCreateAccessKey
        .mockResolvedValueOnce({
          data: undefined,
          error: { message: 'duplicate' },
          response: { status: 409 },
        })
        .mockResolvedValue({
          data: {
            accessKeyId: 'AKIAFRESH',
            secretAccessKey: 'SKFRESH',
            name: CONSOLE_KEY_NAME,
            permissions: [],
            buckets: [],
            createdAt: '2026-01-02T00:00:00Z',
          },
          error: undefined,
          response: { status: 201 },
        });
      mockListAccessKeys.mockResolvedValue({
        data: {
          items: existingAccessKeyId
            ? [
                {
                  accessKeyId: existingAccessKeyId,
                  name: CONSOLE_KEY_NAME,
                  permissions: [],
                  createdAt: '2026-01-01T00:00:00Z',
                },
              ]
            : [],
        },
        error: undefined,
        response: { status: 200 },
      });
      mockDeleteAccessKey.mockResolvedValue({
        data: undefined,
        error: undefined,
        response: { status: 204 },
      });
    }

    it('reuses the existing key when SSM already holds its credentials', async () => {
      stubConflictThenList('AKIAOLD');
      ssmMock.on(GetParameterCommand).resolves({
        Parameter: { Value: JSON.stringify({ accessKeyId: 'AKIAOLD', secretAccessKey: 'SKOLD' }) },
      });

      const result = await ensureTenantReady(deps, orgId);

      expect(result).toBe(orgId);
      expect(mockDeleteAccessKey).not.toHaveBeenCalled();
      expect(mockCreateAccessKey).toHaveBeenCalledTimes(1);
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
      expect(mockDeleteAccessKey).toHaveBeenCalledWith(
        expect.objectContaining({ path: { tenantId: orgId, accessKeyId: 'AKIAOLD' } }),
      );
      expect(mockCreateAccessKey).toHaveBeenCalledTimes(2);
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
      expect(mockDeleteAccessKey).toHaveBeenCalledWith(
        expect.objectContaining({ path: { tenantId: orgId, accessKeyId: 'AKIAOLD' } }),
      );
      expect(mockCreateAccessKey).toHaveBeenCalledTimes(2);
    });

    it('fails (returns null) when the 409 name is absent from the key listing', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      stubConflictThenList(null);

      const result = await ensureTenantReady(deps, orgId);

      expect(result).toBeNull();
      expect(mockDeleteAccessKey).not.toHaveBeenCalled();
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
      '[tenant-setup] setup failed',
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
