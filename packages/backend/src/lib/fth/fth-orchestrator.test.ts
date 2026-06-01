import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { S3Client, CreateBucketCommand, ListBucketsCommand } from '@aws-sdk/client-s3';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    FthManagementApiToken: { value: 'kid.secret' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);
const ssmMock = mockClient(SSMClient);
const s3Mock = mockClient(S3Client);

const mockEnsureFthTenantReady = vi.fn();
vi.mock('./fth-tenant-setup.js', () => ({
  ensureTenantReady: (...args: unknown[]) => mockEnsureFthTenantReady(...args),
}));

const mockFthClient = {
  createAccessKey: vi.fn(),
  listAccessKeys: vi.fn(),
  deleteAccessKey: vi.fn(),
  listStorageUsers: vi.fn(),
};

vi.mock('./fth-management-client.js', async () => {
  const actual = await vi.importActual<typeof import('./fth-management-client.js')>(
    './fth-management-client.js',
  );
  return {
    ...actual,
    createFthManagementClient: vi.fn(() => mockFthClient),
  };
});

vi.mock('./fth-api-metrics.js', () => ({
  instrumentClient: vi.fn(),
}));

process.env.FILONE_STAGE = 'test';
process.env.FTH_S3_URL = 'https://s3.fortilyx.test';
process.env.FTH_MANAGEMENT_API_URL = 'https://api.fortilyx.test';

import { fthOrchestrator, _resetFthOrchestratorCachesForTesting } from './fth-orchestrator.js';
import {
  AccessKeyAlreadyExistsError,
  AccessKeyValidationError,
  BucketAlreadyExistsError,
} from '../service-orchestrator.js';
import { FthApiError, FthConflictError, FthNotFoundError } from './fth-management-client.js';

const orgId = '00000000-0000-0000-0000-000000000001';
const fthClientId = '42';

function profileItem(attrs: Record<string, string>) {
  return Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, { S: v }]));
}

beforeEach(() => {
  ddbMock.reset();
  ssmMock.reset();
  s3Mock.reset();
  vi.clearAllMocks();
  _resetFthOrchestratorCachesForTesting();
});

function stubConsoleStorageUser() {
  mockFthClient.listStorageUsers.mockResolvedValue([
    {
      id: '7',
      userCode: 'filone-console',
      displayName: 'FilOne Console User',
      email: 'console@example.com',
      role: 'storage_user',
      createdAt: '2026-01-01T00:00:00Z',
    },
  ]);
}

describe('fthOrchestrator.ensureTenantReady', () => {
  it('delegates to ensureTenantReady from fth-tenant-setup', async () => {
    mockEnsureFthTenantReady.mockResolvedValue(fthClientId);

    const result = await fthOrchestrator.ensureTenantReady(orgId);

    expect(result).toBe(fthClientId);
    expect(mockEnsureFthTenantReady).toHaveBeenCalledWith(mockFthClient, orgId);
  });

  it('returns null when ensureTenantReady from fth-tenant-setup returns null', async () => {
    mockEnsureFthTenantReady.mockResolvedValue(null);

    const result = await fthOrchestrator.ensureTenantReady(orgId);

    expect(result).toBeNull();
  });
});

describe('fthOrchestrator.isTenantReady', () => {
  const cases: Record<
    string,
    { item: Record<string, string> | undefined; expected: string | null }
  > = {
    'PROFILE row is missing': { item: undefined, expected: null },
    'fthTenantId is missing': { item: {}, expected: null },
    'fthTenantId is set': { item: { fthTenantId: fthClientId }, expected: fthClientId },
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

describe('fthOrchestrator.createBucket', () => {
  beforeEach(() => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ accessKeyId: 'AK', secretAccessKey: 'SK' }) },
    });
  });

  it('issues a CreateBucketCommand for the given bucket name', async () => {
    s3Mock.on(CreateBucketCommand).resolves({});

    await fthOrchestrator.createBucket(fthClientId, { bucketName: 'my-bucket' });

    const calls = s3Mock.commandCalls(CreateBucketCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toMatchObject({ Bucket: 'my-bucket' });
  });

  it('maps BucketAlreadyOwnedByYou to BucketAlreadyExistsError', async () => {
    const err = new Error('Already exists');
    (err as Error & { name: string }).name = 'BucketAlreadyOwnedByYou';
    s3Mock.on(CreateBucketCommand).rejects(err);

    await expect(
      fthOrchestrator.createBucket(fthClientId, { bucketName: 'my-bucket' }),
    ).rejects.toBeInstanceOf(BucketAlreadyExistsError);
  });

  it('throws when lock is requested (FTH does not support it)', async () => {
    await expect(
      fthOrchestrator.createBucket(fthClientId, { bucketName: 'my-bucket', lock: true }),
    ).rejects.toThrow(/lock/i);
  });

  it('throws when retention is requested (FTH does not support it)', async () => {
    await expect(
      fthOrchestrator.createBucket(fthClientId, {
        bucketName: 'my-bucket',
        retention: { enabled: true, mode: 'compliance', duration: 1, durationType: 'd' },
      }),
    ).rejects.toThrow(/retention/i);
  });

  it('throws when versioning is requested (FTH does not support it)', async () => {
    await expect(
      fthOrchestrator.createBucket(fthClientId, { bucketName: 'my-bucket', versioning: true }),
    ).rejects.toThrow(/versioning/i);
  });
});

describe('fthOrchestrator.issueAccessKey', () => {
  const baseOpts = {
    keyName: 'My Key',
    permissions: ['read', 'write'] as const,
    bucketScope: 'all' as const,
  };

  it('issues a key against the filone-console storage user and returns the credential', async () => {
    stubConsoleStorageUser();
    mockFthClient.createAccessKey.mockResolvedValue({
      id: 'AKIAFTH',
      accessKeyId: 'AKIAFTH',
      secretAccessKey: 'sk-secret',
      name: baseOpts.keyName,
      permissions: [],
      buckets: [],
      createdAt: '2026-03-10T00:00:00Z',
    });

    const result = await fthOrchestrator.issueAccessKey(fthClientId, {
      keyName: baseOpts.keyName,
      permissions: [...baseOpts.permissions],
    });

    expect(result).toEqual({
      id: 'AKIAFTH',
      accessKeyId: 'AKIAFTH',
      accessKeySecret: 'sk-secret',
      createdAt: '2026-03-10T00:00:00Z',
    });
    expect(mockFthClient.listStorageUsers).toHaveBeenCalledWith(fthClientId);
    expect(mockFthClient.createAccessKey).toHaveBeenCalledWith(
      fthClientId,
      '7',
      expect.objectContaining({
        name: baseOpts.keyName,
        permissions: expect.arrayContaining(['s3:GetObject', 's3:PutObject', 's3:ListBucket']),
        buckets: [],
        expiresAt: null,
      }),
    );
  });

  it('maps FthConflictError to AccessKeyAlreadyExistsError', async () => {
    stubConsoleStorageUser();
    mockFthClient.createAccessKey.mockRejectedValue(
      new FthConflictError('duplicate', { message: 'duplicate' }),
    );

    await expect(
      fthOrchestrator.issueAccessKey(fthClientId, {
        keyName: baseOpts.keyName,
        permissions: [...baseOpts.permissions],
      }),
    ).rejects.toBeInstanceOf(AccessKeyAlreadyExistsError);
  });

  it('maps 400 FthApiError to AccessKeyValidationError', async () => {
    stubConsoleStorageUser();
    mockFthClient.createAccessKey.mockRejectedValue(
      new FthApiError(400, 'invalid', { message: 'Key name invalid' }),
    );

    await expect(
      fthOrchestrator.issueAccessKey(fthClientId, {
        keyName: baseOpts.keyName,
        permissions: [...baseOpts.permissions],
      }),
    ).rejects.toBeInstanceOf(AccessKeyValidationError);
  });

  it('throws when the console storage user is missing', async () => {
    mockFthClient.listStorageUsers.mockResolvedValue([]);

    await expect(
      fthOrchestrator.issueAccessKey(fthClientId, {
        keyName: baseOpts.keyName,
        permissions: [...baseOpts.permissions],
      }),
    ).rejects.toThrow(/filone-console/);
    expect(mockFthClient.createAccessKey).not.toHaveBeenCalled();
  });

  it('caches the storage user id across calls in the same warm container', async () => {
    stubConsoleStorageUser();
    mockFthClient.createAccessKey.mockResolvedValue({
      accessKeyId: 'AKIAFTH',
      secretAccessKey: 'sk-secret',
      name: baseOpts.keyName,
      permissions: [],
      buckets: [],
      createdAt: '2026-03-10T00:00:00Z',
    });

    await fthOrchestrator.issueAccessKey(fthClientId, {
      keyName: 'k1',
      permissions: ['read'],
    });
    await fthOrchestrator.issueAccessKey(fthClientId, {
      keyName: 'k2',
      permissions: ['read'],
    });

    expect(mockFthClient.listStorageUsers).toHaveBeenCalledTimes(1);
  });
});

describe('fthOrchestrator.findAccessKeyByName', () => {
  it('returns id/accessKeyId/createdAt when a key with the given name exists', async () => {
    mockFthClient.listAccessKeys.mockResolvedValue([
      {
        id: 'AKIA1',
        accessKeyId: 'AKIA1',
        name: 'Other',
        permissions: [],
        buckets: [],
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'AKIA2',
        accessKeyId: 'AKIA2',
        name: 'Wanted',
        permissions: [],
        buckets: [],
        createdAt: '2026-02-01T00:00:00Z',
      },
    ]);

    const result = await fthOrchestrator.findAccessKeyByName(fthClientId, 'Wanted');

    expect(result).toEqual({
      id: 'AKIA2',
      accessKeyId: 'AKIA2',
      createdAt: '2026-02-01T00:00:00Z',
    });
  });

  it('returns undefined when no key matches', async () => {
    mockFthClient.listAccessKeys.mockResolvedValue([]);

    const result = await fthOrchestrator.findAccessKeyByName(fthClientId, 'Wanted');

    expect(result).toBeUndefined();
  });
});

describe('fthOrchestrator.deleteAccessKey', () => {
  it('delegates to the management client deleteAccessKey', async () => {
    mockFthClient.deleteAccessKey.mockResolvedValue(undefined);

    await fthOrchestrator.deleteAccessKey(fthClientId, 'AKIAFTH');

    expect(mockFthClient.deleteAccessKey).toHaveBeenCalledWith(
      fthClientId,
      'AKIAFTH',
      expect.objectContaining({ idempotencyKey: `delete-AKIAFTH` }),
    );
  });

  it('treats FthNotFoundError as success (idempotent delete)', async () => {
    mockFthClient.deleteAccessKey.mockRejectedValue(
      new FthNotFoundError('not found', { message: 'not found' }),
    );

    await expect(fthOrchestrator.deleteAccessKey(fthClientId, 'AKIAFTH')).resolves.toBeUndefined();
  });

  it('rethrows other API errors with context', async () => {
    mockFthClient.deleteAccessKey.mockRejectedValue(
      new FthApiError(500, 'boom', { message: 'boom' }),
    );

    await expect(fthOrchestrator.deleteAccessKey(fthClientId, 'AKIAFTH')).rejects.toThrow(
      /Failed to delete FTH access key/,
    );
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
        bucketName: 'b1',
        region: 'us-east-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        isPublic: false,
        versioning: false,
        encrypted: true,
      },
      {
        bucketName: 'b2',
        region: 'us-east-1',
        createdAt: '2026-02-01T00:00:00.000Z',
        isPublic: false,
        versioning: false,
        encrypted: true,
      },
    ]);
  });
});
