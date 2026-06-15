import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  S3Client,
  CreateBucketCommand,
  ListBucketsCommand,
  PutBucketVersioningCommand,
  PutObjectLockConfigurationCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
} from '@aws-sdk/client-s3';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    FthManagementApiToken: { value: 'kid.secret' },
  },
}));

const ssmMock = mockClient(SSMClient);
const s3Mock = mockClient(S3Client);

const mockEnsureFthTenantReady = vi.fn();
const mockUpdateClientStatus = vi.fn();
const mockGetClient = vi.fn();
vi.mock('./fth-tenant-setup.js', () => ({
  ensureTenantReady: (...args: unknown[]) => mockEnsureFthTenantReady(...args),
}));

const mockGetClientMetricsTimeseries = vi.fn();
// Hoisted so it is initialized before the static import of fth-orchestrator.js,
// whose module-level `createInstrumentedFthClient()` runs at import time and
// reads this mock via the mocked createFthManagementClient.
const mockFthClient = vi.hoisted(() => ({
  createAccessKey: vi.fn(),
  listAccessKeys: vi.fn(),
  deleteAccessKey: vi.fn(),
  listStorageUsers: vi.fn(),
  getClientMetricsTimeseries: (...args: unknown[]) => mockGetClientMetricsTimeseries(...args),
  updateClientStatus: (...args: unknown[]) => mockUpdateClientStatus(...args),
  getClient: (...args: unknown[]) => mockGetClient(...args),
}));

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

import {
  AccessKeyAlreadyExistsError,
  AccessKeyValidationError,
  BucketAlreadyExistsError,
  BucketConfigurationError,
} from '../errors.js';
import { FthApiError, FthConflictError, FthNotFoundError } from './fth-management-client.js';

import { fthOrchestrator, _resetFthOrchestratorCachesForTesting } from './fth-orchestrator.js';

const orgId = '00000000-0000-0000-0000-000000000001';
const fthClientId = '42';

function profileItem(attrs: Record<string, string>) {
  return Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, { S: v }]));
}

beforeEach(() => {
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
    it(`returns ${expected === null ? 'null' : 'tenantId'} when ${desc}`, () => {
      const result = fthOrchestrator.isTenantReady(item ? profileItem(item) : undefined);
      expect(result).toBe(expected);
    });
  }
});

describe('fthOrchestrator.updateTenantStatus', () => {
  for (const status of ['active', 'write-locked', 'disabled'] as const) {
    it(`passes "${status}" straight through to updateClientStatus`, async () => {
      mockUpdateClientStatus.mockResolvedValue(undefined);

      await fthOrchestrator.updateTenantStatus(fthClientId, status);

      expect(mockUpdateClientStatus).toHaveBeenCalledWith(fthClientId, { status });
    });
  }

  it('retries updateClientStatus on a transient failure then succeeds', async () => {
    vi.useFakeTimers();
    mockUpdateClientStatus
      .mockRejectedValueOnce(new Error('transient FTH error'))
      .mockResolvedValue(undefined);

    const promise = fthOrchestrator.updateTenantStatus(fthClientId, 'write-locked');
    await vi.runAllTimersAsync();
    await promise;

    expect(mockUpdateClientStatus).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('gives up on updateClientStatus after exhausting retries (1 initial + 3 retries)', async () => {
    vi.useFakeTimers();
    mockUpdateClientStatus.mockRejectedValue(new Error('persistent FTH error'));

    const promise = fthOrchestrator.updateTenantStatus(fthClientId, 'write-locked').catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await promise;

    expect(err).toBeInstanceOf(Error);
    expect(mockUpdateClientStatus).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });
});

describe('fthOrchestrator.getTenantStatus', () => {
  for (const status of ['active', 'write-locked', 'disabled'] as const) {
    it(`returns the normalized "${status}" status from getClient`, async () => {
      mockGetClient.mockResolvedValue({ id: fthClientId, status });

      const result = await fthOrchestrator.getTenantStatus(fthClientId);

      expect(result).toEqual({ kind: 'ok', status });
      expect(mockGetClient).toHaveBeenCalledWith(fthClientId);
    });
  }

  it('returns status undefined when FTH reports an unmodeled status', async () => {
    mockGetClient.mockResolvedValue({ id: fthClientId, status: 'provisioning' });

    const result = await fthOrchestrator.getTenantStatus(fthClientId);

    expect(result).toEqual({ kind: 'ok', status: undefined });
  });

  it('returns status undefined when the client record has no status', async () => {
    mockGetClient.mockResolvedValue({ id: fthClientId });

    const result = await fthOrchestrator.getTenantStatus(fthClientId);

    expect(result).toEqual({ kind: 'ok', status: undefined });
  });

  it('maps FthNotFoundError to not_found', async () => {
    mockGetClient.mockRejectedValue(new FthNotFoundError('nope', undefined));

    const result = await fthOrchestrator.getTenantStatus(fthClientId);

    expect(result).toEqual({ kind: 'not_found' });
  });

  it('maps any other error to an error result', async () => {
    const cause = new FthApiError(500, 'boom', undefined);
    mockGetClient.mockRejectedValue(cause);

    const result = await fthOrchestrator.getTenantStatus(fthClientId);

    expect(result).toEqual({ kind: 'error', cause });
  });
});

describe('fthOrchestrator.getS3ClientContext', () => {
  it('reads credentials from SSM and returns the FTH endpoint context', async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ accessKeyId: 'AK1', secretAccessKey: 'SK1' }) },
    });

    const ctx = await fthOrchestrator.getS3ClientContext(fthClientId);

    expect(ctx).toEqual({
      endpointUrl: 'https://us-east-1.fortilyx.com',
      region: 'us-east-1',
      credentials: { accessKeyId: 'AK1', secretAccessKey: 'SK1' },
      forcePathStyle: true,
    });
  });

  it('caches SSM lookups across calls', async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ accessKeyId: 'AK1', secretAccessKey: 'SK1' }) },
    });

    await fthOrchestrator.getS3ClientContext(fthClientId);
    await fthOrchestrator.getS3ClientContext(fthClientId);

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

  it('enables versioning via PutBucketVersioning when versioning:true', async () => {
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutBucketVersioningCommand).resolves({});

    await fthOrchestrator.createBucket(fthClientId, { bucketName: 'my-bucket', versioning: true });

    const calls = s3Mock.commandCalls(PutBucketVersioningCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toMatchObject({
      Bucket: 'my-bucket',
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  it('passes ObjectLockEnabledForBucket and enables versioning when lock+versioning', async () => {
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutBucketVersioningCommand).resolves({});

    await fthOrchestrator.createBucket(fthClientId, {
      bucketName: 'my-bucket',
      versioning: true,
      lock: true,
    });

    const createCalls = s3Mock.commandCalls(CreateBucketCommand);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].args[0].input).toMatchObject({
      Bucket: 'my-bucket',
      ObjectLockEnabledForBucket: true,
    });
    expect(s3Mock.commandCalls(PutBucketVersioningCommand)).toHaveLength(1);
  });

  it('configures default retention when versioning+lock+retention', async () => {
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutBucketVersioningCommand).resolves({});
    s3Mock.on(PutObjectLockConfigurationCommand).resolves({});

    await fthOrchestrator.createBucket(fthClientId, {
      bucketName: 'my-bucket',
      versioning: true,
      lock: true,
      retention: { enabled: true, mode: 'governance', duration: 7, durationType: 'd' },
    });

    const calls = s3Mock.commandCalls(PutObjectLockConfigurationCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toMatchObject({
      Bucket: 'my-bucket',
      ObjectLockConfiguration: {
        Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 7 } },
      },
    });
  });

  it('wraps a PutBucketVersioning failure in BucketConfigurationError noting the bucket exists', async () => {
    vi.useFakeTimers();
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutBucketVersioningCommand).rejects(new Error('AccessDenied'));

    const promise = fthOrchestrator
      .createBucket(fthClientId, { bucketName: 'my-bucket', versioning: true })
      .catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await promise;

    expect(err).toMatchObject({ name: 'BucketConfigurationError', bucketName: 'my-bucket' });
    vi.useRealTimers();
  });

  it('wraps a PutObjectLockConfiguration failure in BucketConfigurationError', async () => {
    vi.useFakeTimers();
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutBucketVersioningCommand).resolves({});
    const cause = new Error('transient S3 error');
    s3Mock.on(PutObjectLockConfigurationCommand).rejects(cause);

    const promise = fthOrchestrator
      .createBucket(fthClientId, {
        bucketName: 'my-bucket',
        versioning: true,
        lock: true,
        retention: { enabled: true, mode: 'governance', duration: 7, durationType: 'd' },
      })
      .catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await promise;

    expect(err).toBeInstanceOf(BucketConfigurationError);
    expect(err.cause).toBe(cause);
    vi.useRealTimers();
  });

  it('retries PutBucketVersioning on a transient failure then succeeds', async () => {
    vi.useFakeTimers();
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutBucketVersioningCommand).rejectsOnce(new Error('transient S3 error')).resolves({});

    const promise = fthOrchestrator.createBucket(fthClientId, {
      bucketName: 'my-bucket',
      versioning: true,
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(s3Mock.commandCalls(PutBucketVersioningCommand)).toHaveLength(2);
    vi.useRealTimers();
  });

  it('gives up on PutBucketVersioning after exhausting retries (1 initial + 3 retries)', async () => {
    vi.useFakeTimers();
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutBucketVersioningCommand).rejects(new Error('persistent S3 error'));

    const promise = fthOrchestrator
      .createBucket(fthClientId, { bucketName: 'my-bucket', versioning: true })
      .catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await promise;

    expect(err).toBeInstanceOf(BucketConfigurationError);
    expect(s3Mock.commandCalls(PutBucketVersioningCommand)).toHaveLength(4);
    vi.useRealTimers();
  });

  it('retries PutObjectLockConfiguration on a transient failure then succeeds', async () => {
    vi.useFakeTimers();
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutBucketVersioningCommand).resolves({});
    s3Mock
      .on(PutObjectLockConfigurationCommand)
      .rejectsOnce(new Error('transient S3 error'))
      .resolves({});

    const promise = fthOrchestrator.createBucket(fthClientId, {
      bucketName: 'my-bucket',
      versioning: true,
      lock: true,
      retention: { enabled: true, mode: 'governance', duration: 7, durationType: 'd' },
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(s3Mock.commandCalls(PutObjectLockConfigurationCommand)).toHaveLength(2);
    vi.useRealTimers();
  });

  it('does not call PutBucketVersioning or PutObjectLockConfiguration for a plain bucket', async () => {
    s3Mock.on(CreateBucketCommand).resolves({});

    await fthOrchestrator.createBucket(fthClientId, { bucketName: 'my-bucket' });

    expect(s3Mock.commandCalls(PutBucketVersioningCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(PutObjectLockConfigurationCommand)).toHaveLength(0);
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
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Suspended' });

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

  it('reflects per-bucket versioning state from GetBucketVersioning', async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ accessKeyId: 'AK', secretAccessKey: 'SK' }) },
    });
    s3Mock.on(ListBucketsCommand).resolves({
      Buckets: [
        { Name: 'versioned', CreationDate: new Date('2026-01-01T00:00:00Z') },
        { Name: 'plain', CreationDate: new Date('2026-02-01T00:00:00Z') },
      ],
    });
    s3Mock.on(GetBucketVersioningCommand).callsFake((input) => ({
      Status: input.Bucket === 'versioned' ? 'Enabled' : 'Suspended',
    }));

    const result = await fthOrchestrator.listBuckets(fthClientId);

    expect(result.find((b) => b.bucketName === 'versioned')?.versioning).toBe(true);
    expect(result.find((b) => b.bucketName === 'plain')?.versioning).toBe(false);
  });

  it('propagates GetBucketVersioning failures instead of swallowing them', async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ accessKeyId: 'AK', secretAccessKey: 'SK' }) },
    });
    s3Mock.on(ListBucketsCommand).resolves({
      Buckets: [{ Name: 'b1', CreationDate: new Date('2026-01-01T00:00:00Z') }],
    });
    s3Mock.on(GetBucketVersioningCommand).rejects(new Error('AccessDenied'));

    await expect(fthOrchestrator.listBuckets(fthClientId)).rejects.toThrow(/AccessDenied/);
  });

  it('propagates ListBuckets failures', async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ accessKeyId: 'AK', secretAccessKey: 'SK' }) },
    });
    s3Mock.on(ListBucketsCommand).rejects(new Error('ServiceUnavailable'));

    await expect(fthOrchestrator.listBuckets(fthClientId)).rejects.toThrow(/ServiceUnavailable/);
  });
});

describe('fthOrchestrator.getBucket', () => {
  beforeEach(() => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ accessKeyId: 'AK', secretAccessKey: 'SK' }) },
    });
  });

  it('returns BucketDetails with createdAt from ListBuckets when the bucket matches', async () => {
    s3Mock.on(ListBucketsCommand).resolves({
      Buckets: [
        { Name: 'other', CreationDate: new Date('2026-01-01T00:00:00Z') },
        { Name: 'my-bucket', CreationDate: new Date('2026-02-15T10:00:00Z') },
      ],
    });
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Suspended' });
    const notFound = new Error('not configured');
    (notFound as Error & { name: string }).name = 'ObjectLockConfigurationNotFoundError';
    s3Mock.on(GetObjectLockConfigurationCommand).rejects(notFound);

    const result = await fthOrchestrator.getBucket(fthClientId, 'my-bucket');

    expect(result).toMatchObject({
      bucketName: 'my-bucket',
      region: 'us-east-1',
      createdAt: '2026-02-15T10:00:00.000Z',
      isPublic: false,
      versioning: false,
      encrypted: true,
      objectLockEnabled: false,
    });
  });

  it('merges versioning + object-lock + retention into BucketDetails', async () => {
    s3Mock.on(ListBucketsCommand).resolves({
      Buckets: [{ Name: 'my-bucket', CreationDate: new Date('2026-02-15T10:00:00Z') }],
    });
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    s3Mock.on(GetObjectLockConfigurationCommand).resolves({
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 7 } },
      },
    });

    const result = await fthOrchestrator.getBucket(fthClientId, 'my-bucket');

    expect(result).toMatchObject({
      bucketName: 'my-bucket',
      versioning: true,
      objectLockEnabled: true,
      defaultRetention: 'governance',
      retentionDuration: 7,
      retentionDurationType: 'd',
    });
  });

  it('treats ObjectLockConfigurationNotFoundError as not-locked', async () => {
    s3Mock.on(ListBucketsCommand).resolves({
      Buckets: [{ Name: 'my-bucket', CreationDate: new Date('2026-02-15T10:00:00Z') }],
    });
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Suspended' });
    const notFound = new Error('not configured');
    (notFound as Error & { name: string }).name = 'ObjectLockConfigurationNotFoundError';
    s3Mock.on(GetObjectLockConfigurationCommand).rejects(notFound);

    const result = await fthOrchestrator.getBucket(fthClientId, 'my-bucket');

    expect(result?.objectLockEnabled).toBe(false);
    expect(result).not.toHaveProperty('defaultRetention');
    expect(result).not.toHaveProperty('retentionDuration');
    expect(result).not.toHaveProperty('retentionDurationType');
  });

  it('returns null when the bucket is not present in ListBuckets', async () => {
    s3Mock.on(ListBucketsCommand).resolves({
      Buckets: [{ Name: 'other', CreationDate: new Date('2026-01-01T00:00:00Z') }],
    });

    const result = await fthOrchestrator.getBucket(fthClientId, 'missing-bucket');

    expect(result).toBeNull();
  });
});

describe('fthOrchestrator.getTenantUsageMetrics', () => {
  const FROM = '2026-01-01T00:00:00Z';
  const TO = '2026-01-31T00:00:00Z';

  beforeEach(() => {
    mockGetClientMetricsTimeseries.mockResolvedValue({ points: [] });
  });

  it('calls getClientMetricsTimeseries with tenantId as clientRef and defaults interval to "1d"', async () => {
    await fthOrchestrator.getTenantUsageMetrics(fthClientId, { from: FROM, to: TO });

    expect(mockGetClientMetricsTimeseries).toHaveBeenCalledWith(fthClientId, {
      from: FROM,
      to: TO,
      interval: '1d',
    });
  });

  it('forwards a custom interval when provided', async () => {
    await fthOrchestrator.getTenantUsageMetrics(fthClientId, {
      from: FROM,
      to: TO,
      interval: '24h',
    });

    expect(mockGetClientMetricsTimeseries).toHaveBeenCalledWith(
      fthClientId,
      expect.objectContaining({ interval: '24h' }),
    );
  });

  it('maps points to normalized storage and egress shapes', async () => {
    mockGetClientMetricsTimeseries.mockResolvedValue({
      points: [
        {
          ts: '2026-01-01T01:00:00Z',
          usage_avg_bytes: 2048,
          object_count_avg: 10,
          egress_bytes: 512,
        },
        {
          ts: '2026-01-01T02:00:00Z',
          usage_avg_bytes: 4096,
          object_count_avg: 20,
          egress_bytes: 1024,
        },
      ],
    });

    const result = await fthOrchestrator.getTenantUsageMetrics(fthClientId, {
      from: FROM,
      to: TO,
    });

    expect(result.storage).toEqual([
      { timestamp: '2026-01-01T01:00:00.000Z', bytesUsed: 2048, objectCount: 10 },
      { timestamp: '2026-01-01T02:00:00.000Z', bytesUsed: 4096, objectCount: 20 },
    ]);
    expect(result.egress).toEqual([
      { timestamp: '2026-01-01T01:00:00.000Z', bytesUsed: 512 },
      { timestamp: '2026-01-01T02:00:00.000Z', bytesUsed: 1024 },
    ]);
  });

  it('applies ?? 0 defaults for missing usage_avg_bytes, object_count_avg, and egress_bytes', async () => {
    mockGetClientMetricsTimeseries.mockResolvedValue({
      points: [{ ts: '2026-01-01T01:00:00Z' }],
    });

    const result = await fthOrchestrator.getTenantUsageMetrics(fthClientId, {
      from: FROM,
      to: TO,
    });

    expect(result.storage).toEqual([
      { timestamp: '2026-01-01T01:00:00.000Z', bytesUsed: 0, objectCount: 0 },
    ]);
    expect(result.egress).toEqual([{ timestamp: '2026-01-01T01:00:00.000Z', bytesUsed: 0 }]);
  });

  it('drops points without ts', async () => {
    mockGetClientMetricsTimeseries.mockResolvedValue({
      points: [
        { ts: '2026-01-01T01:00:00Z', usage_avg_bytes: 100, egress_bytes: 50 },
        { usage_avg_bytes: 200, egress_bytes: 100 }, // no ts — should be dropped
      ],
    });

    const result = await fthOrchestrator.getTenantUsageMetrics(fthClientId, {
      from: FROM,
      to: TO,
    });

    expect(result.storage).toHaveLength(1);
    expect(result.egress).toHaveLength(1);
    expect(result.storage[0]?.timestamp).toBe('2026-01-01T01:00:00.000Z');
    expect(result.egress[0]?.timestamp).toBe('2026-01-01T01:00:00.000Z');
  });

  it('returns empty arrays when points is undefined', async () => {
    mockGetClientMetricsTimeseries.mockResolvedValue({});

    const result = await fthOrchestrator.getTenantUsageMetrics(fthClientId, {
      from: FROM,
      to: TO,
    });

    expect(result).toEqual({ storage: [], egress: [] });
  });

  it('returns empty arrays when points is an empty array', async () => {
    mockGetClientMetricsTimeseries.mockResolvedValue({ points: [] });

    const result = await fthOrchestrator.getTenantUsageMetrics(fthClientId, {
      from: FROM,
      to: TO,
    });

    expect(result).toEqual({ storage: [], egress: [] });
  });
});
