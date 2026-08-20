import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
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
  deleteClient: vi.fn(),
};

const fthClient = mockFthClient as unknown as FthManagementClient;

vi.mock('./fth-api-metrics.js', () => ({
  instrumentClient: vi.fn(),
}));

process.env.FILONE_STAGE = 'test';
process.env.FTH_MANAGEMENT_API_URL = 'https://api.fortilyx.test';

import { ensureTenantReady } from './fth-tenant-setup.js';
import { OrgDeletingError } from '../org-profile.js';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';

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

  // The deferred risk: this request read the profile before the fence landed, so
  // it created a client upstream that will never get a local pointer.
  describe('when the fence lands mid-setup', () => {
    function refuseWith(item?: Record<string, unknown>) {
      ddbMock.on(GetItemCommand).resolves({ Item: profileItem({}) });
      ddbMock.on(UpdateItemCommand).rejects(
        new ConditionalCheckFailedException({
          message: 'refused',
          $metadata: {},
          Item: item,
        } as never),
      );
    }

    it('deletes the orphaned client and refuses, rather than answering 503', async () => {
      stubSetupApiCalls();
      refuseWith({ deleting: { BOOL: true } });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await expect(ensureTenantReady(fthClient, orgId)).rejects.toBeInstanceOf(OrgDeletingError);
        expect(mockFthClient.deleteClient).toHaveBeenCalledWith(fthClientId);
      } finally {
        warn.mockRestore();
      }
    });

    // The condition names no tenant-id attribute, so a concurrent writer cannot
    // refuse this write. A refusal carrying no item means no profile row, and
    // returning the id would hand back an upstream client nothing recorded.
    it('deletes the orphaned client and refuses when the profile is missing', async () => {
      stubSetupApiCalls();
      refuseWith(undefined);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await expect(ensureTenantReady(fthClient, orgId)).resolves.toBeNull();
        expect(mockFthClient.deleteClient).toHaveBeenCalledWith(fthClientId);
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }
    });

    // A failed rollback must not turn the refusal into "try again in a moment".
    it('still refuses when the client cannot be deleted', async () => {
      stubSetupApiCalls();
      refuseWith({ deleting: { BOOL: true } });
      mockFthClient.deleteClient.mockRejectedValue(new Error('FTH 500'));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await expect(ensureTenantReady(fthClient, orgId)).rejects.toBeInstanceOf(OrgDeletingError);
        expect(error).toHaveBeenCalled();
      } finally {
        error.mockRestore();
      }
    });
  });

  // Before any upstream call: refusing only the final pointer write would
  // leave the client, its console key and its SSM secret orphaned.
  it('refuses a deleting org without provisioning anything', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: { ...profileItem({}), deleting: { BOOL: true } } });

    await expect(ensureTenantReady(fthClient, orgId)).rejects.toBeInstanceOf(OrgDeletingError);
    expect(mockFthClient.createClient).not.toHaveBeenCalled();
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
  });

  it('conditions the pointer write so it cannot resurrect a purged profile', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: profileItem({}) });
    ddbMock.on(UpdateItemCommand).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    stubSetupApiCalls();

    await ensureTenantReady(fthClient, orgId);

    expect(ddbMock.commandCalls(UpdateItemCommand)[0].args[0].input.ConditionExpression).toBe(
      'attribute_exists(pk) AND attribute_not_exists(deleting)',
    );
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
        idempotencyKey: `console-key-test-${fthClientId}-${serviceUserId}`,
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

  // This test describes an error we experienced in e2e tests,
  // after the org was re-provisioned onto a new FTH client and storage user.
  it('varies the access-key idempotency key when the org is re-provisioned', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: profileItem({}) });
    ddbMock.on(UpdateItemCommand).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    stubSetupApiCalls();

    await ensureTenantReady(fthClient, orgId);

    // Re-provisioning lands the org on a new client and storage user.
    mockFthClient.createClient.mockResolvedValue({
      id: '99',
      externalId: orgId,
      displayName: `FilOne test ${orgId}`,
      createdAt: '2026-01-01T00:00:00Z',
    });
    mockFthClient.createStorageUser.mockResolvedValue({
      id: '13',
      userCode: 'filone-console',
      displayName: 'FilOne Console User',
      email: 'console-test-99@filone.internal',
      role: 'storage_user',
      createdAt: '2026-01-01T00:00:00Z',
    });

    await ensureTenantReady(fthClient, orgId);

    const idempotencyKeys = mockFthClient.createAccessKey.mock.calls.map(
      ([, , args]) => args.idempotencyKey,
    );
    expect(new Set(idempotencyKeys).size).toBe(2);
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
