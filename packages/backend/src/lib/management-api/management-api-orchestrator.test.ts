import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
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
import { S3Region } from '@filone/shared';
import type { Client } from '@filone/management-api-client';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

// The generated SDK is mocked at the module boundary. `createClient` returns a
// sentinel that must appear as the `client` field on every SDK call; each
// operation returns the hey-api `{ data, error, response }` result shape.
const MOCK_CLIENT = 'mock-management-client';
const mockCreateClient = vi.fn((_config: Record<string, unknown>) => MOCK_CLIENT);
const mockSetStatus = vi.fn((_o: Record<string, unknown>) => ({}));
const mockGetTenant = vi.fn((_o: Record<string, unknown>) => ({}));
const mockCreateAccessKey = vi.fn((_o: Record<string, unknown>) => ({}));
const mockListAccessKeys = vi.fn((_o: Record<string, unknown>) => ({}));
const mockDeleteAccessKey = vi.fn((_o: Record<string, unknown>) => ({}));
const mockGetTenantMetrics = vi.fn((_o: Record<string, unknown>) => ({}));
const mockGetBucketMetrics = vi.fn((_o: Record<string, unknown>) => ({}));

vi.mock('@filone/management-api-client', () => ({
  createClient: (config: Record<string, unknown>) => mockCreateClient(config),
  postTenantsByTenantIdStatus: (o: Record<string, unknown>) => mockSetStatus(o),
  getTenantsByTenantId: (o: Record<string, unknown>) => mockGetTenant(o),
  postTenantsByTenantIdAccessKeys: (o: Record<string, unknown>) => mockCreateAccessKey(o),
  getTenantsByTenantIdAccessKeys: (o: Record<string, unknown>) => mockListAccessKeys(o),
  deleteTenantsByTenantIdAccessKeysByAccessKeyId: (o: Record<string, unknown>) =>
    mockDeleteAccessKey(o),
  getTenantsByTenantIdMetrics: (o: Record<string, unknown>) => mockGetTenantMetrics(o),
  getTenantsByTenantIdBucketsByBucketNameMetrics: (o: Record<string, unknown>) =>
    mockGetBucketMetrics(o),
}));

vi.mock('./management-api-metrics.js', () => ({
  instrumentClient: vi.fn(),
}));

const ddbMock = mockClient(DynamoDBClient);
const ssmMock = mockClient(SSMClient);
const s3Mock = mockClient(S3Client);

import {
  AccessKeyAlreadyExistsError,
  AccessKeyValidationError,
  BucketAlreadyExistsError,
  BucketConfigurationError,
  BucketNotFoundError,
  NotImplementedError,
} from '../errors.js';
import { _resetS3CredentialsCacheForTesting } from '../s3-credentials.js';
import { instrumentClient } from './management-api-metrics.js';
import {
  createManagementApiOrchestrator,
  type ManagementApiOrchestratorConfig,
} from './management-api-orchestrator.js';

const orgId = '00000000-0000-0000-0000-000000000001';
// tenantId === orgId for Management API orchestrators (client-supplied UUID).
const tenantId = orgId;

// hey-api result-shape helpers.
function ok<T>(data: T, status = 200) {
  return { data, error: undefined, response: { status } };
}
function noContent(status = 204) {
  return { data: undefined, error: undefined, response: { status } };
}
function fail(status: number, message = 'error') {
  return { data: undefined, error: { message }, response: { status } };
}

function buildOrchestrator(overrides?: { api?: ManagementApiOrchestratorConfig['api'] }) {
  return createManagementApiOrchestrator({
    id: 'forge',
    region: S3Region.UsEast1,
    stage: 'test',
    s3EndpointUrl: 'https://us-east-1.s3.test.example.com',
    api: overrides?.api ?? { baseUrl: 'https://api.example.com', accessToken: 'partner-key' },
  });
}

const orchestrator = buildOrchestrator();

function profileItem(attrs: Record<string, string>) {
  return Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, { S: v }]));
}

function stubS3Credentials() {
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: { Value: JSON.stringify({ accessKeyId: 'AK1', secretAccessKey: 'SK1' }) },
  });
}

const emptyMetrics = {
  storage: { samples: [] },
  egress: { samples: [] },
  ingress: { samples: [] },
};

beforeEach(() => {
  ddbMock.reset();
  ssmMock.reset();
  s3Mock.reset();
  vi.clearAllMocks();
  _resetS3CredentialsCacheForTesting();
});

describe('createManagementApiOrchestrator config', () => {
  it('exposes the configured id and region', () => {
    expect(orchestrator.id).toBe('forge');
    expect(orchestrator.region).toBe(S3Region.UsEast1);
  });

  it('does not instrument an injected client', () => {
    buildOrchestrator({ api: { client: MOCK_CLIENT as unknown as Client } });
    expect(instrumentClient).not.toHaveBeenCalled();
  });

  it('builds and instruments a client from baseUrl + token settings', () => {
    buildOrchestrator({ api: { baseUrl: 'https://api.example.com', accessToken: 'partner-key' } });

    // Bearer credential is supplied as a lazy callback, never a literal.
    const config = mockCreateClient.mock.calls[0][0] as {
      baseUrl: string;
      auth: () => string;
    };
    expect(config.baseUrl).toBe('https://api.example.com');
    expect(config.auth()).toBe('partner-key');
    expect(instrumentClient).toHaveBeenCalledWith(MOCK_CLIENT, { apiName: 'forge-management' });
  });
});

describe('ensureTenantReady', () => {
  it('short-circuits to the stored tenantId via the id-derived PROFILE attribute', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: profileItem({ forgeTenantId: tenantId }) });

    const result = await orchestrator.ensureTenantReady(orgId);

    expect(result).toBe(tenantId);
    // putTenant is issued by tenant-setup; short-circuit means no create call.
    expect(mockCreateAccessKey).not.toHaveBeenCalled();
  });
});

describe('isTenantReady', () => {
  const cases: Record<
    string,
    { item: Record<string, string> | undefined; expected: string | null }
  > = {
    'PROFILE row is missing': { item: undefined, expected: null },
    'forgeTenantId is missing': { item: {}, expected: null },
    "only another orchestrator's attribute is set": {
      item: { fthTenantId: 'other' },
      expected: null,
    },
    'forgeTenantId is set': { item: { forgeTenantId: tenantId }, expected: tenantId },
  };

  for (const [desc, { item, expected }] of Object.entries(cases)) {
    it(`returns ${expected === null ? 'null' : 'tenantId'} when ${desc}`, () => {
      const result = orchestrator.isTenantReady(item ? profileItem(item) : undefined);
      expect(result).toBe(expected);
    });
  }
});

describe('updateTenantStatus', () => {
  for (const status of ['active', 'write-locked', 'disabled'] as const) {
    it(`passes "${status}" straight through to the status endpoint`, async () => {
      mockSetStatus.mockResolvedValue(noContent());

      await orchestrator.updateTenantStatus(tenantId, status);

      expect(mockSetStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          client: MOCK_CLIENT,
          path: { tenantId },
          body: { status },
          throwOnError: false,
        }),
      );
    });
  }

  it('throws when the status update fails', async () => {
    mockSetStatus.mockResolvedValue(fail(500, 'upstream error'));

    await expect(orchestrator.updateTenantStatus(tenantId, 'write-locked')).rejects.toThrow(
      `Failed to set tenant ${tenantId} status to "write-locked"`,
    );
  });
});

describe('getTenantStatus', () => {
  it('returns the status from the tenant record', async () => {
    mockGetTenant.mockResolvedValue(ok({ tenantId, status: 'write-locked' }));

    const result = await orchestrator.getTenantStatus(tenantId);

    expect(result).toEqual({ kind: 'ok', status: 'write-locked' });
    expect(mockGetTenant).toHaveBeenCalledWith(
      expect.objectContaining({ client: MOCK_CLIENT, path: { tenantId }, throwOnError: false }),
    );
  });

  it('returns status undefined for an unmodeled upstream status', async () => {
    mockGetTenant.mockResolvedValue(ok({ tenantId, status: 'provisioning' }));

    const result = await orchestrator.getTenantStatus(tenantId);

    expect(result).toEqual({ kind: 'ok', status: undefined });
  });

  it('maps a 404 to not_found', async () => {
    mockGetTenant.mockResolvedValue(fail(404, 'nope'));

    await expect(orchestrator.getTenantStatus(tenantId)).resolves.toEqual({ kind: 'not_found' });
  });

  it('never throws: any other error result becomes an error probe', async () => {
    const result = fail(500, 'boom');
    mockGetTenant.mockResolvedValue(result);

    await expect(orchestrator.getTenantStatus(tenantId)).resolves.toEqual({
      kind: 'error',
      cause: result.error,
    });
  });

  it('never throws: a transport failure becomes an error probe', async () => {
    const cause = new Error('network down');
    mockGetTenant.mockRejectedValue(cause);

    await expect(orchestrator.getTenantStatus(tenantId)).resolves.toEqual({ kind: 'error', cause });
  });
});

describe('getS3ClientContext', () => {
  it('reads credentials from SSM and returns the configured endpoint context', async () => {
    stubS3Credentials();

    const ctx = await orchestrator.getS3ClientContext(tenantId);

    expect(ctx).toEqual({
      endpointUrl: 'https://us-east-1.s3.test.example.com',
      region: 'us-east-1',
      credentials: { accessKeyId: 'AK1', secretAccessKey: 'SK1' },
      forcePathStyle: true,
      orchestratorId: 'forge',
      tenantId,
    });
    const [call] = ssmMock.commandCalls(GetParameterCommand);
    expect(call.args[0].input.Name).toBe(`/filone/test/forge-s3/access-key/${tenantId}`);
  });

  it('signs against the orchestrator region', async () => {
    stubS3Credentials();

    const ctx = await orchestrator.getS3ClientContext(tenantId);

    expect(ctx.region).toBe('us-east-1');
  });
});

describe('createBucket', () => {
  beforeEach(stubS3Credentials);

  it('issues a CreateBucketCommand for the given bucket name', async () => {
    s3Mock.on(CreateBucketCommand).resolves({});

    await orchestrator.createBucket(tenantId, { bucketName: 'my-bucket' });

    const calls = s3Mock.commandCalls(CreateBucketCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toMatchObject({ Bucket: 'my-bucket' });
    expect(s3Mock.commandCalls(PutBucketVersioningCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(PutObjectLockConfigurationCommand)).toHaveLength(0);
  });

  it('maps BucketAlreadyOwnedByYou to BucketAlreadyExistsError', async () => {
    const err = new Error('Already exists');
    (err as Error & { name: string }).name = 'BucketAlreadyOwnedByYou';
    s3Mock.on(CreateBucketCommand).rejects(err);

    await expect(
      orchestrator.createBucket(tenantId, { bucketName: 'my-bucket' }),
    ).rejects.toBeInstanceOf(BucketAlreadyExistsError);
  });

  it('enables versioning, object lock and default retention when requested', async () => {
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutBucketVersioningCommand).resolves({});
    s3Mock.on(PutObjectLockConfigurationCommand).resolves({});

    await orchestrator.createBucket(tenantId, {
      bucketName: 'my-bucket',
      versioning: true,
      lock: true,
      retention: { enabled: true, mode: 'governance', duration: 7, durationType: 'd' },
    });

    expect(s3Mock.commandCalls(CreateBucketCommand)[0].args[0].input).toMatchObject({
      Bucket: 'my-bucket',
      ObjectLockEnabledForBucket: true,
    });
    expect(s3Mock.commandCalls(PutBucketVersioningCommand)[0].args[0].input).toMatchObject({
      Bucket: 'my-bucket',
      VersioningConfiguration: { Status: 'Enabled' },
    });
    expect(s3Mock.commandCalls(PutObjectLockConfigurationCommand)[0].args[0].input).toMatchObject({
      Bucket: 'my-bucket',
      ObjectLockConfiguration: { Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 7 } } },
    });
  });

  it('retries a transient versioning failure then succeeds', async () => {
    vi.useFakeTimers();
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutBucketVersioningCommand).rejectsOnce(new Error('transient S3 error')).resolves({});

    const promise = orchestrator.createBucket(tenantId, {
      bucketName: 'my-bucket',
      versioning: true,
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(s3Mock.commandCalls(PutBucketVersioningCommand)).toHaveLength(2);
    vi.useRealTimers();
  });

  it('wraps an exhausted follow-up failure in BucketConfigurationError', async () => {
    vi.useFakeTimers();
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutBucketVersioningCommand).rejects(new Error('persistent S3 error'));

    const promise = orchestrator
      .createBucket(tenantId, { bucketName: 'my-bucket', versioning: true })
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await promise;

    expect(err).toMatchObject({ name: 'BucketConfigurationError', bucketName: 'my-bucket' });
    expect(err).toBeInstanceOf(BucketConfigurationError);
    // 1 initial + 3 retries
    expect(s3Mock.commandCalls(PutBucketVersioningCommand)).toHaveLength(4);
    vi.useRealTimers();
  });
});

describe('deleteBucket', () => {
  it('throws NotImplementedError (parity with aurora/fth)', async () => {
    await expect(orchestrator.deleteBucket(tenantId, 'my-bucket')).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});

describe('listBuckets', () => {
  it('maps S3 gateway buckets to summaries with per-bucket versioning', async () => {
    stubS3Credentials();
    s3Mock.on(ListBucketsCommand).resolves({
      Buckets: [{ Name: 'bucket-a', CreationDate: new Date('2026-01-01T00:00:00Z') }],
    });
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });

    const result = await orchestrator.listBuckets(tenantId);

    expect(result).toEqual([
      {
        bucketName: 'bucket-a',
        region: S3Region.UsEast1,
        createdAt: '2026-01-01T00:00:00.000Z',
        isPublic: false,
        versioning: true,
        encrypted: true,
      },
    ]);
  });
});

describe('getBucket', () => {
  beforeEach(stubS3Credentials);

  it('returns null when the bucket is not in the tenant listing', async () => {
    s3Mock.on(ListBucketsCommand).resolves({ Buckets: [] });

    await expect(orchestrator.getBucket(tenantId, 'missing')).resolves.toBeNull();
  });

  it('returns details including object-lock state', async () => {
    s3Mock.on(ListBucketsCommand).resolves({
      Buckets: [{ Name: 'bucket-a', CreationDate: new Date('2026-01-01T00:00:00Z') }],
    });
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    s3Mock.on(GetObjectLockConfigurationCommand).resolves({
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 7 } },
      },
    });

    const result = await orchestrator.getBucket(tenantId, 'bucket-a');

    expect(result).toEqual({
      bucketName: 'bucket-a',
      region: S3Region.UsEast1,
      createdAt: '2026-01-01T00:00:00.000Z',
      isPublic: false,
      versioning: true,
      encrypted: true,
      objectLockEnabled: true,
      defaultRetention: 'governance',
      retentionDuration: 7,
      retentionDurationType: 'd',
    });
  });
});

describe('issueAccessKey', () => {
  const createdKey = {
    accessKeyId: 'AKIAFORGE',
    secretAccessKey: 'sk-secret',
    name: 'My Key',
    permissions: [],
    buckets: [],
    createdAt: '2026-03-10T00:00:00Z',
  };

  it('maps permissions to s3 actions and returns the credential with id = accessKeyId', async () => {
    mockCreateAccessKey.mockResolvedValue(ok(createdKey, 201));

    const result = await orchestrator.issueAccessKey(tenantId, {
      keyName: 'My Key',
      permissions: ['read', 'write'],
    });

    expect(result).toEqual({
      id: 'AKIAFORGE',
      accessKeyId: 'AKIAFORGE',
      accessKeySecret: 'sk-secret',
      createdAt: '2026-03-10T00:00:00Z',
    });
    expect(mockCreateAccessKey).toHaveBeenCalledWith(
      expect.objectContaining({
        client: MOCK_CLIENT,
        path: { tenantId },
        body: expect.objectContaining({
          name: 'My Key',
          permissions: expect.arrayContaining([
            's3:ListAllMyBuckets',
            's3:GetObject',
            's3:ListBucket',
            's3:PutObject',
          ]),
          buckets: [],
          expiresAt: null,
        }),
        throwOnError: false,
      }),
    );
  });

  it('maps granular permissions and bucket scopes', async () => {
    mockCreateAccessKey.mockResolvedValue(ok(createdKey, 201));

    await orchestrator.issueAccessKey(tenantId, {
      keyName: 'My Key',
      permissions: ['delete', 'CreateBucket', 'DeleteBucket'],
      granularPermissions: ['GetObjectVersion', 'PutObjectRetention'],
      buckets: ['bucket-a'],
      expiresAt: '2027-01-01T00:00:00Z',
    });

    expect(mockCreateAccessKey).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          name: 'My Key',
          permissions: expect.arrayContaining([
            's3:DeleteObject',
            's3:CreateBucket',
            's3:DeleteBucket',
            's3:GetObjectVersion',
            's3:PutObjectRetention',
          ]),
          buckets: ['bucket-a'],
          expiresAt: '2027-01-01T00:00:00Z',
        }),
      }),
    );
  });

  it('drops bucket-info permissions the contract enum lacks, with a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockCreateAccessKey.mockResolvedValue(ok(createdKey, 201));

    await orchestrator.issueAccessKey(tenantId, {
      keyName: 'My Key',
      permissions: ['read', 'GetBucketVersioning', 'GetBucketObjectLockConfiguration'],
    });

    const { permissions } = mockCreateAccessKey.mock.calls[0][0].body as { permissions: string[] };
    expect(permissions).not.toContain('s3:GetBucketVersioning');
    expect(permissions).not.toContain('s3:GetBucketObjectLockConfiguration');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('GetBucketVersioning'));
  });

  it('maps a 409 to AccessKeyAlreadyExistsError', async () => {
    mockCreateAccessKey.mockResolvedValue(fail(409, 'duplicate'));

    await expect(
      orchestrator.issueAccessKey(tenantId, { keyName: 'My Key', permissions: ['read'] }),
    ).rejects.toBeInstanceOf(AccessKeyAlreadyExistsError);
  });

  it('maps a 422 to AccessKeyValidationError with the upstream message', async () => {
    mockCreateAccessKey.mockResolvedValue(fail(422, 'Key name invalid'));

    const err: unknown = await orchestrator
      .issueAccessKey(tenantId, { keyName: 'My Key', permissions: ['read'] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessKeyValidationError);
    expect((err as Error).message).toBe('Key name invalid');
  });

  it('wraps other errors with context', async () => {
    mockCreateAccessKey.mockResolvedValue(fail(500, 'boom'));

    await expect(
      orchestrator.issueAccessKey(tenantId, { keyName: 'My Key', permissions: ['read'] }),
    ).rejects.toThrow(`Failed to create forge access key "My Key" for tenant ${tenantId}`);
  });

  it('never logs the secret', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockCreateAccessKey.mockResolvedValue(ok(createdKey, 201));

    await orchestrator.issueAccessKey(tenantId, { keyName: 'My Key', permissions: ['read'] });

    for (const call of logSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('sk-secret');
    }
  });
});

describe('findAccessKeyByName', () => {
  it('returns the matching key metadata', async () => {
    mockListAccessKeys.mockResolvedValue(
      ok({
        items: [
          { accessKeyId: 'AK1', name: 'other', createdAt: '2026-01-01T00:00:00Z', permissions: [] },
          {
            accessKeyId: 'AK2',
            name: 'target',
            createdAt: '2026-01-02T00:00:00Z',
            permissions: [],
          },
        ],
      }),
    );

    await expect(orchestrator.findAccessKeyByName(tenantId, 'target')).resolves.toEqual({
      id: 'AK2',
      accessKeyId: 'AK2',
      createdAt: '2026-01-02T00:00:00Z',
    });
  });

  it('returns undefined when no key matches', async () => {
    mockListAccessKeys.mockResolvedValue(ok({ items: [] }));

    await expect(orchestrator.findAccessKeyByName(tenantId, 'target')).resolves.toBeUndefined();
  });
});

describe('deleteAccessKey', () => {
  it('deletes via the SDK', async () => {
    mockDeleteAccessKey.mockResolvedValue(noContent());

    await orchestrator.deleteAccessKey(tenantId, 'AK1');

    expect(mockDeleteAccessKey).toHaveBeenCalledWith(
      expect.objectContaining({
        client: MOCK_CLIENT,
        path: { tenantId, accessKeyId: 'AK1' },
        throwOnError: false,
      }),
    );
  });

  it('treats a 404 as already deleted', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockDeleteAccessKey.mockResolvedValue(fail(404, 'tenant gone'));

    await expect(orchestrator.deleteAccessKey(tenantId, 'AK1')).resolves.toBeUndefined();
  });

  it('wraps and rethrows other errors so callers keep the DDB row', async () => {
    mockDeleteAccessKey.mockResolvedValue(fail(500, 'boom'));

    await expect(orchestrator.deleteAccessKey(tenantId, 'AK1')).rejects.toThrow(
      `Failed to delete forge access key "AK1" for tenant ${tenantId}`,
    );
  });
});

describe('getTenantUsageMetrics', () => {
  it('maps the default 1d interval to a 24h window and maps both series', async () => {
    mockGetTenantMetrics.mockResolvedValue(
      ok({
        storage: {
          samples: [{ timestamp: '2026-01-01T01:00:00Z', bytesUsed: 100, objectCount: 3 }],
        },
        egress: { samples: [{ timestamp: '2026-01-01T01:00:00Z', bytesEgressed: 55 }] },
        ingress: { samples: [{ timestamp: '2026-01-01T01:00:00Z', bytesIngested: 77 }] },
      }),
    );

    const result = await orchestrator.getTenantUsageMetrics(tenantId, {
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-08T00:00:00Z',
    });

    expect(mockGetTenantMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        client: MOCK_CLIENT,
        path: { tenantId },
        query: { from: '2026-01-01T00:00:00Z', to: '2026-01-08T00:00:00Z', window: '24h' },
        throwOnError: false,
      }),
    );
    expect(result).toEqual({
      storage: [{ timestamp: '2026-01-01T01:00:00.000Z', bytesUsed: 100, objectCount: 3 }],
      egress: [{ timestamp: '2026-01-01T01:00:00.000Z', bytesUsed: 55 }],
    });
  });

  const windowCases: Record<string, string> = {
    '1h': '1h',
    '24h': '24h',
    '1d': '24h',
    '30d': '720h',
  };

  for (const [interval, window] of Object.entries(windowCases)) {
    it(`maps interval "${interval}" to window "${window}"`, async () => {
      mockGetTenantMetrics.mockResolvedValue(ok(emptyMetrics));

      await orchestrator.getTenantUsageMetrics(tenantId, {
        from: '2026-01-01T00:00:00Z',
        to: '2026-02-01T00:00:00Z',
        interval,
      });

      expect(mockGetTenantMetrics).toHaveBeenCalledWith(
        expect.objectContaining({ query: expect.objectContaining({ window }) }),
      );
    });
  }
});

describe('getTenantInfo', () => {
  it('maps the tenant record to the quota snapshot', async () => {
    mockGetTenant.mockResolvedValue(
      ok({
        tenantId,
        status: 'active',
        bucketCount: 3,
        bucketLimit: 100,
        accessKeyCount: 5,
        accessKeyLimit: 300,
        createdAt: '2026-01-01T00:00:00Z',
      }),
    );

    await expect(orchestrator.getTenantInfo(tenantId)).resolves.toEqual({
      bucketCount: 3,
      bucketLimit: 100,
      keyCount: 5,
      accessKeyLimit: 300,
      status: 'active',
    });
  });
});

describe('getBucketUsageMetrics', () => {
  it('returns mapped storage samples without a client-side ownership pre-check', async () => {
    mockGetBucketMetrics.mockResolvedValue(
      ok({
        storage: {
          samples: [{ timestamp: '2026-01-01T01:00:00Z', bytesUsed: 42, objectCount: 2 }],
        },
        egress: { samples: [] },
        ingress: { samples: [] },
      }),
    );

    const result = await orchestrator.getBucketUsageMetrics(tenantId, 'bucket-a', {
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T00:00:00Z',
      interval: '1h',
    });

    expect(result).toEqual([
      { timestamp: '2026-01-01T01:00:00.000Z', bytesUsed: 42, objectCount: 2 },
    ]);
    expect(mockGetBucketMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        client: MOCK_CLIENT,
        path: { tenantId, bucketName: 'bucket-a' },
        query: { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z', window: '1h' },
        throwOnError: false,
      }),
    );
    // Ownership is enforced upstream (404), so no S3 listing happens here.
    expect(s3Mock.commandCalls(ListBucketsCommand)).toHaveLength(0);
  });

  it('maps an upstream 404 to BucketNotFoundError', async () => {
    mockGetBucketMetrics.mockResolvedValue(fail(404, 'bucket not owned'));

    await expect(
      orchestrator.getBucketUsageMetrics(tenantId, 'bucket-a', {
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-02T00:00:00Z',
      }),
    ).rejects.toBeInstanceOf(BucketNotFoundError);
  });

  it('returns an empty array for an owned bucket with no series yet', async () => {
    mockGetBucketMetrics.mockResolvedValue(ok(emptyMetrics));

    await expect(
      orchestrator.getBucketUsageMetrics(tenantId, 'bucket-a', {
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-02T00:00:00Z',
      }),
    ).resolves.toEqual([]);
  });

  it('wraps non-404 errors with context', async () => {
    mockGetBucketMetrics.mockResolvedValue(fail(500, 'boom'));

    await expect(
      orchestrator.getBucketUsageMetrics(tenantId, 'bucket-a', {
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-02T00:00:00Z',
      }),
    ).rejects.toThrow('Failed to fetch usage metrics for bucket "bucket-a"');
  });
});
