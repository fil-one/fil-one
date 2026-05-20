import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  NotFound,
} from '@aws-sdk/client-s3';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    FthToken: { value: 'kid.secret' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);
const ssmMock = mockClient(SSMClient);
const s3Mock = mockClient(S3Client);

const mockFthClient = {
  createClient: vi.fn(),
  getClient: vi.fn(),
  createStorageUser: vi.fn(),
  listStorageUsers: vi.fn(),
  getStorageUser: vi.fn(),
  createAccessKey: vi.fn(),
  listAccessKeys: vi.fn(),
  getAccessKey: vi.fn(),
  deleteAccessKey: vi.fn(),
  rotateToken: vi.fn(),
  interceptors: {
    request: { use: vi.fn() },
    response: { use: vi.fn() },
    error: { use: vi.fn() },
  },
};

vi.mock('./fth-client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./fth-client.js')>();
  return {
    ...original,
    createFthClient: vi.fn(() => mockFthClient),
  };
});

process.env.FILONE_STAGE = 'test';
process.env.FTH_API_URL = 'https://api.fortilyx.test';
process.env.FTH_S3_URL = 'https://s3.fortilyx.test';

import { fthOrchestrator, _resetFthOrchestratorCachesForTesting } from './fth-orchestrator.js';
import {
  AccessKeyAlreadyExistsError,
  AccessKeyValidationError,
  BucketAlreadyExistsError,
  type IssueAccessKeyOpts,
} from '../service-orchestrator.js';
import { FTH_TENANT_FINAL_SETUP_STATUS, FthTenantSetupStatus } from './fth-tenant-setup-status.js';
import { FthApiError, FthConflictError } from './fth-client.js';

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
  mockFthClient.listStorageUsers.mockResolvedValue([]);
  mockFthClient.createStorageUser.mockResolvedValue({
    id: serviceUserId,
    userCode: 'filone-console',
    displayName: 'FilOne Console User',
    email: `console-${fthClientId}@filone.internal`,
    role: 'storage_user',
    createdAt: '2026-01-01T00:00:00Z',
  });
  mockFthClient.listAccessKeys.mockResolvedValue([]);
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
  s3Mock.reset();
  vi.clearAllMocks();
  _resetFthOrchestratorCachesForTesting();
});

describe('fthOrchestrator.ensureTenantReady', () => {
  it('returns the existing fthTenantId when setup is already complete', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: profileItem({
        fthTenantId: fthClientId,
        fthSetupStatus: FTH_TENANT_FINAL_SETUP_STATUS,
      }),
    });

    const result = await fthOrchestrator.ensureTenantReady(orgId);

    expect(result).toBe(fthClientId);
    expect(mockFthClient.createClient).not.toHaveBeenCalled();
  });

  it('creates client, storage user, access key, SSM cred and PROFILE row on first run', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: profileItem({}) });
    ddbMock.on(UpdateItemCommand).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    stubSetupApiCalls();

    const result = await fthOrchestrator.ensureTenantReady(orgId);

    expect(result).toBe(fthClientId);
    expect(mockFthClient.createClient).toHaveBeenCalledWith({
      externalId: orgId,
      displayName: `FilOne test ${orgId}`,
      idempotencyKey: orgId,
    });
    expect(mockFthClient.createStorageUser).toHaveBeenCalledWith(
      fthClientId,
      expect.objectContaining({
        email: `console-${fthClientId}@filone.internal`,
        userCode: 'filone-console',
        role: 'storage_user',
        issueS3Credentials: false,
        idempotencyKey: `${orgId}-console-user`,
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
    expect(mockFthClient.deleteAccessKey).not.toHaveBeenCalled();

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
      ':status': { S: FTH_TENANT_FINAL_SETUP_STATUS },
    });
  });

  it('reuses the existing filone-console storage user when one is already present', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: profileItem({}) });
    ddbMock.on(UpdateItemCommand).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    stubSetupApiCalls();
    mockFthClient.listStorageUsers.mockResolvedValue([
      {
        id: serviceUserId,
        userCode: 'filone-console',
        displayName: 'FilOne Console User',
        email: `console-${fthClientId}@filone.internal`,
        role: 'storage_user',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ]);

    await fthOrchestrator.ensureTenantReady(orgId);

    expect(mockFthClient.createStorageUser).not.toHaveBeenCalled();
    expect(mockFthClient.createAccessKey).toHaveBeenCalledWith(
      fthClientId,
      serviceUserId,
      expect.objectContaining({ name: 'filone-console' }),
    );
  });

  it('deletes a stale filone-console access key before issuing a new one', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: profileItem({}) });
    ddbMock.on(UpdateItemCommand).resolves({});
    ssmMock.on(PutParameterCommand).resolves({});
    stubSetupApiCalls();
    mockFthClient.listAccessKeys.mockResolvedValue([
      {
        accessKeyId: 'AKIASTALE',
        name: 'filone-console',
        permissions: [],
        buckets: [],
        createdAt: '2026-01-01T00:00:00Z',
      },
    ]);
    mockFthClient.deleteAccessKey.mockResolvedValue(undefined);

    await fthOrchestrator.ensureTenantReady(orgId);

    expect(mockFthClient.deleteAccessKey).toHaveBeenCalledWith(fthClientId, 'AKIASTALE', {
      idempotencyKey: `${orgId}-console-key-delete`,
    });
    expect(mockFthClient.createAccessKey).toHaveBeenCalledWith(
      fthClientId,
      serviceUserId,
      expect.objectContaining({ name: 'filone-console' }),
    );
  });
});

describe('fthOrchestrator.isTenantReady', () => {
  const cases: Record<
    string,
    { item: Record<string, string> | undefined; expected: string | null }
  > = {
    'PROFILE row is missing': { item: undefined, expected: null },
    'fthTenantId is missing': { item: { fthSetupStatus: 'whatever' }, expected: null },
    'fthSetupStatus is missing': { item: { fthTenantId: fthClientId }, expected: null },
    'fthSetupStatus is an intermediate state': {
      item: {
        fthTenantId: fthClientId,
        fthSetupStatus: FthTenantSetupStatus.FTH_CLIENT_CREATED,
      },
      expected: null,
    },
    'setup is complete': {
      item: { fthTenantId: fthClientId, fthSetupStatus: FTH_TENANT_FINAL_SETUP_STATUS },
      expected: fthClientId,
    },
  };

  for (const [desc, { item, expected }] of Object.entries(cases)) {
    it(`returns ${expected === null ? 'null' : 'tenantId'} when ${desc}`, async () => {
      ddbMock.on(GetItemCommand).resolves({
        Item: item ? profileItem(item) : undefined,
      });

      const result = await fthOrchestrator.isTenantReady(orgId);
      expect(result).toBe(expected);
    });
  }
});

describe('fthOrchestrator.getPresignerContext', () => {
  it('reads credentials from SSM and returns the FTH endpoint context', async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ accessKeyId: 'AK1', secretAccessKey: 'SK1' }) },
    });

    const ctx = await fthOrchestrator.getPresignerContext(fthClientId);

    expect(ctx).toEqual({
      endpointUrl: 'https://s3.fortilyx.test',
      region: 'us-east-1',
      credentials: { accessKeyId: 'AK1', secretAccessKey: 'SK1' },
      forcePathStyle: true,
    });
  });

  it('caches SSM lookups across calls', async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ accessKeyId: 'AK1', secretAccessKey: 'SK1' }) },
    });

    await fthOrchestrator.getPresignerContext(fthClientId);
    await fthOrchestrator.getPresignerContext(fthClientId);

    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);
  });
});

describe('fthOrchestrator.issueAccessKey', () => {
  const issueOpts: IssueAccessKeyOpts = {
    keyName: 'demo-key',
    permissions: ['read', 'write'],
    buckets: [],
    expiresAt: null,
  };

  it('finds the filone-console storage user and creates the access key', async () => {
    mockFthClient.listStorageUsers.mockResolvedValue([
      {
        id: '99',
        userCode: 'someone-else',
        displayName: 'X',
        email: 'x',
        role: 'r',
        createdAt: 'd',
      },
      {
        id: serviceUserId,
        userCode: 'filone-console',
        displayName: 'C',
        email: 'c',
        role: 'storage_user',
        createdAt: '2026-01-01',
      },
    ]);
    mockFthClient.createAccessKey.mockResolvedValue({
      id: 'k1',
      accessKeyId: 'AKIA1',
      secretAccessKey: 'SECRET1',
      createdAt: '2026-01-01T00:00:00Z',
      name: 'demo-key',
      permissions: [],
      buckets: [],
    });

    const issued = await fthOrchestrator.issueAccessKey(fthClientId, issueOpts);

    expect(mockFthClient.createAccessKey).toHaveBeenCalledWith(
      fthClientId,
      serviceUserId,
      expect.objectContaining({ name: 'demo-key' }),
    );
    expect(issued).toMatchObject({
      accessKeyId: 'AKIA1',
      accessKeySecret: 'SECRET1',
      createdAt: '2026-01-01T00:00:00Z',
    });
  });

  it('maps FthConflictError (409) to AccessKeyAlreadyExistsError', async () => {
    mockFthClient.listStorageUsers.mockResolvedValue([
      {
        id: serviceUserId,
        userCode: 'filone-console',
        displayName: 'C',
        email: 'c',
        role: 'storage_user',
        createdAt: 'd',
      },
    ]);
    mockFthClient.createAccessKey.mockRejectedValue(
      new FthConflictError('exists', { message: 'exists' }),
    );

    await expect(fthOrchestrator.issueAccessKey(fthClientId, issueOpts)).rejects.toBeInstanceOf(
      AccessKeyAlreadyExistsError,
    );
  });

  it('maps 400 FthApiError to AccessKeyValidationError', async () => {
    mockFthClient.listStorageUsers.mockResolvedValue([
      {
        id: serviceUserId,
        userCode: 'filone-console',
        displayName: 'C',
        email: 'c',
        role: 'storage_user',
        createdAt: 'd',
      },
    ]);
    mockFthClient.createAccessKey.mockRejectedValue(
      new FthApiError(400, 'bad permissions', { message: 'bad permissions' }),
    );

    await expect(fthOrchestrator.issueAccessKey(fthClientId, issueOpts)).rejects.toBeInstanceOf(
      AccessKeyValidationError,
    );
  });

  it('throws if no filone-console user exists for the tenant', async () => {
    mockFthClient.listStorageUsers.mockResolvedValue([
      {
        id: '99',
        userCode: 'someone-else',
        displayName: 'X',
        email: 'x',
        role: 'r',
        createdAt: 'd',
      },
    ]);

    await expect(fthOrchestrator.issueAccessKey(fthClientId, issueOpts)).rejects.toThrow(
      /filone-console/,
    );
  });
});

describe('fthOrchestrator.findAccessKeyByName', () => {
  it('returns the matching key from listAccessKeys', async () => {
    mockFthClient.listAccessKeys.mockResolvedValue([
      { id: 'a', accessKeyId: 'AK1', name: 'one', permissions: [], buckets: [], createdAt: 'd1' },
      { id: 'b', accessKeyId: 'AK2', name: 'two', permissions: [], buckets: [], createdAt: 'd2' },
    ]);

    const result = await fthOrchestrator.findAccessKeyByName(fthClientId, 'two');

    expect(result).toEqual({ id: 'b', accessKeyId: 'AK2', createdAt: 'd2' });
  });

  it('returns undefined when no key matches', async () => {
    mockFthClient.listAccessKeys.mockResolvedValue([]);

    const result = await fthOrchestrator.findAccessKeyByName(fthClientId, 'missing');
    expect(result).toBeUndefined();
  });
});

describe('fthOrchestrator.createBucket', () => {
  beforeEach(() => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ accessKeyId: 'AK', secretAccessKey: 'SK' }) },
    });
  });

  it('issues a CreateBucketCommand for the given bucket name', async () => {
    s3Mock.on(CreateBucketCommand).resolves({});

    await fthOrchestrator.createBucket({ tenantId: fthClientId, bucketName: 'my-bucket' });

    const calls = s3Mock.commandCalls(CreateBucketCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toMatchObject({ Bucket: 'my-bucket' });
  });

  it('maps BucketAlreadyOwnedByYou to BucketAlreadyExistsError', async () => {
    const err = new Error('Already exists');
    (err as Error & { name: string }).name = 'BucketAlreadyOwnedByYou';
    s3Mock.on(CreateBucketCommand).rejects(err);

    await expect(
      fthOrchestrator.createBucket({ tenantId: fthClientId, bucketName: 'my-bucket' }),
    ).rejects.toBeInstanceOf(BucketAlreadyExistsError);
  });

  it('throws when lock is requested (FTH does not support it)', async () => {
    await expect(
      fthOrchestrator.createBucket({
        tenantId: fthClientId,
        bucketName: 'my-bucket',
        lock: true,
      }),
    ).rejects.toThrow(/lock/i);
  });

  it('throws when retention is requested (FTH does not support it)', async () => {
    await expect(
      fthOrchestrator.createBucket({
        tenantId: fthClientId,
        bucketName: 'my-bucket',
        retention: { enabled: true, mode: 'compliance', duration: 1, durationType: 'd' },
      }),
    ).rejects.toThrow(/retention/i);
  });
});

describe('fthOrchestrator.deleteBucket', () => {
  it('issues a DeleteBucketCommand for the given bucket name', async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ accessKeyId: 'AK', secretAccessKey: 'SK' }) },
    });
    s3Mock.on(DeleteBucketCommand).resolves({});

    await fthOrchestrator.deleteBucket(fthClientId, 'my-bucket');

    const calls = s3Mock.commandCalls(DeleteBucketCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toMatchObject({ Bucket: 'my-bucket' });
  });
});

describe('fthOrchestrator.listBuckets', () => {
  it('maps S3 ListBuckets response to BucketSummary[]', async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ accessKeyId: 'AK', secretAccessKey: 'SK' }) },
    });
    s3Mock.on(ListBucketsCommand).resolves({
      Buckets: [
        { Name: 'b1', CreationDate: new Date('2026-01-01T00:00:00Z') },
        { Name: 'b2', CreationDate: new Date('2026-02-01T00:00:00Z') },
      ],
    });

    const result = await fthOrchestrator.listBuckets(fthClientId);

    expect(result).toEqual([
      {
        name: 'b1',
        region: 'us-east-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        isPublic: false,
        versioning: false,
        encrypted: true,
      },
      {
        name: 'b2',
        region: 'us-east-1',
        createdAt: '2026-02-01T00:00:00.000Z',
        isPublic: false,
        versioning: false,
        encrypted: true,
      },
    ]);
  });
});

describe('fthOrchestrator.getBucket', () => {
  beforeEach(() => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ accessKeyId: 'AK', secretAccessKey: 'SK' }) },
    });
  });

  it('returns minimal BucketDetails when the bucket exists', async () => {
    s3Mock.on(HeadBucketCommand).resolves({});
    s3Mock.on(ListBucketsCommand).resolves({
      Buckets: [{ Name: 'my-bucket', CreationDate: new Date('2026-01-01T00:00:00Z') }],
    });

    const result = await fthOrchestrator.getBucket(fthClientId, 'my-bucket');

    expect(result).toMatchObject({ name: 'my-bucket', createdAt: '2026-01-01T00:00:00.000Z' });
  });

  it('returns null on NotFound from HeadBucket', async () => {
    s3Mock.on(HeadBucketCommand).rejects(new NotFound({ message: 'not found', $metadata: {} }));

    const result = await fthOrchestrator.getBucket(fthClientId, 'missing');
    expect(result).toBeNull();
  });
});
