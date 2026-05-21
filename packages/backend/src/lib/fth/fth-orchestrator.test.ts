import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { S3Client, CreateBucketCommand, ListBucketsCommand } from '@aws-sdk/client-s3';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);
const ssmMock = mockClient(SSMClient);
const s3Mock = mockClient(S3Client);

const mockEnsureFthTenantReady = vi.fn();
vi.mock('./fth-tenant-setup.js', () => ({
  ensureTenantReady: (...args: unknown[]) => mockEnsureFthTenantReady(...args),
}));

process.env.FILONE_STAGE = 'test';
process.env.FTH_S3_URL = 'https://s3.fortilyx.test';

import { fthOrchestrator, _resetFthOrchestratorCachesForTesting } from './fth-orchestrator.js';
import { BucketAlreadyExistsError } from '../service-orchestrator.js';

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

describe('fthOrchestrator.ensureTenantReady', () => {
  it('delegates to ensureTenantReady from fth-tenant-setup', async () => {
    mockEnsureFthTenantReady.mockResolvedValue(fthClientId);

    const result = await fthOrchestrator.ensureTenantReady(orgId);

    expect(result).toBe(fthClientId);
    expect(mockEnsureFthTenantReady).toHaveBeenCalledWith(orgId);
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
