import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import {
  S3Client,
  NoSuchBucket,
  CreateBucketCommand,
  DeleteBucketCommand,
  ListBucketsCommand,
  PutBucketVersioningCommand,
  PutObjectLockConfigurationCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
} from '@aws-sdk/client-s3';
import { S3Region } from '@filone/shared';
import type { Client } from '@filone/orchestrator-client';

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
const mockDeleteTenant = vi.fn((_o: Record<string, unknown>) => ({}));
const mockGetTenantMetrics = vi.fn((_o: Record<string, unknown>) => ({}));
const mockGetBucketMetrics = vi.fn((_o: Record<string, unknown>) => ({}));
const mockGetPrincipalAccess = vi.fn((_o: Record<string, unknown>) => ({}));
const mockPutPrincipal = vi.fn((_o: Record<string, unknown>) => ({}));

vi.mock('@filone/orchestrator-client', () => ({
  createClient: (config: Record<string, unknown>) => mockCreateClient(config),
  postTenantsByTenantIdStatus: (o: Record<string, unknown>) => mockSetStatus(o),
  getTenantsByTenantId: (o: Record<string, unknown>) => mockGetTenant(o),
  deleteTenantsByTenantId: (o: Record<string, unknown>) => mockDeleteTenant(o),
  postTenantsByTenantIdAccessKeys: (o: Record<string, unknown>) => mockCreateAccessKey(o),
  getTenantsByTenantIdAccessKeys: (o: Record<string, unknown>) => mockListAccessKeys(o),
  deleteTenantsByTenantIdAccessKeysByAccessKeyId: (o: Record<string, unknown>) =>
    mockDeleteAccessKey(o),
  getTenantsByTenantIdMetrics: (o: Record<string, unknown>) => mockGetTenantMetrics(o),
  getTenantsByTenantIdBucketsByBucketNameMetrics: (o: Record<string, unknown>) =>
    mockGetBucketMetrics(o),
  getTenantsByTenantIdPrincipalsByPrincipalIdAccess: (o: Record<string, unknown>) =>
    mockGetPrincipalAccess(o),
  putTenantsByTenantIdPrincipalsByPrincipalId: (o: Record<string, unknown>) => mockPutPrincipal(o),
}));

vi.mock('./metrics.ts', () => ({
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
  BucketNotEmptyError,
  BucketNotFoundError,
} from '../errors.ts';
import type { OrchestratorRequestOptions } from '../service-orchestrator.ts';
import { _resetS3CredentialsCacheForTesting } from '../s3-credentials.ts';
import { instrumentClient } from './metrics.ts';
import { createFilOneOrchestrator } from './arms.ts';
import { type FilOneOrchestratorConfig } from './orchestrator.ts';

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

function buildOrchestrator(overrides?: {
  api?: FilOneOrchestratorConfig['api'];
  accessModel?: FilOneOrchestratorConfig['accessModel'];
}) {
  return createFilOneOrchestrator({
    id: 'forge',
    region: S3Region.UsEast1,
    stage: 'test',
    s3EndpointUrl: 'https://us-east-1.s3.test.example.com',
    api: overrides?.api ?? { baseUrl: 'https://api.example.com', accessToken: 'partner-key' },
    ...(overrides?.accessModel && { accessModel: overrides.accessModel }),
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

describe('createFilOneOrchestrator config', () => {
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

describe('deleteTenant', () => {
  it('disables the tenant before deleting it', async () => {
    mockSetStatus.mockResolvedValue(noContent());
    mockDeleteTenant.mockResolvedValue(noContent());

    await orchestrator.deleteTenant(tenantId);

    expect(mockSetStatus).toHaveBeenCalledWith(
      expect.objectContaining({ path: { tenantId }, body: { status: 'disabled' } }),
    );
    expect(mockDeleteTenant).toHaveBeenCalledWith(
      expect.objectContaining({ client: MOCK_CLIENT, path: { tenantId }, throwOnError: false }),
    );
    expect(mockSetStatus.mock.invocationCallOrder[0]!).toBeLessThan(
      mockDeleteTenant.mock.invocationCallOrder[0]!,
    );
  });

  it('re-disables and retries when a competing writer causes a 409', async () => {
    vi.useFakeTimers();
    mockSetStatus.mockResolvedValue(noContent());
    mockDeleteTenant
      .mockResolvedValueOnce(fail(409, 'tenant is not disabled'))
      .mockResolvedValue(noContent());

    const promise = orchestrator.deleteTenant(tenantId);
    await vi.runAllTimersAsync();
    await promise;

    expect(mockDeleteTenant).toHaveBeenCalledTimes(2);
    expect(mockSetStatus).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('treats a 404 from the delete as gone, without retrying', async () => {
    mockSetStatus.mockResolvedValue(noContent());
    mockDeleteTenant.mockResolvedValue(fail(404, 'not found'));

    await expect(orchestrator.deleteTenant(tenantId)).resolves.toBeUndefined();
    expect(mockDeleteTenant).toHaveBeenCalledTimes(1);
  });

  // The disable is only the delete's precondition; skipping the delete would
  // abandon a pass that failed partway through cleanup.
  it('still deletes when the tenant is already missing from the status call', async () => {
    mockSetStatus.mockResolvedValue(fail(404, 'not found'));
    mockDeleteTenant.mockResolvedValue(noContent());

    await expect(orchestrator.deleteTenant(tenantId)).resolves.toBeUndefined();
    expect(mockDeleteTenant).toHaveBeenCalledTimes(1);
    expect(mockSetStatus).toHaveBeenCalledTimes(1);
  });

  it('propagates a failing delete even when the status call 404s', async () => {
    vi.useFakeTimers();
    mockSetStatus.mockResolvedValue(fail(404, 'not found'));
    mockDeleteTenant.mockResolvedValue(fail(500, 'boom'));

    const promise = orchestrator.deleteTenant(tenantId).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    expect(await promise).toMatchObject({
      message: `Failed to delete forge tenant ${tenantId}`,
    });
    expect(mockDeleteTenant).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it('still throws when the status call fails for any other reason', async () => {
    vi.useFakeTimers();
    mockSetStatus.mockResolvedValue(fail(500, 'boom'));
    mockDeleteTenant.mockResolvedValue(noContent());

    const promise = orchestrator.deleteTenant(tenantId).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    expect(await promise).toMatchObject({
      message: `Failed to set tenant ${tenantId} status to "disabled"`,
    });
    expect(mockDeleteTenant).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('throws once the retry budget is exhausted', async () => {
    vi.useFakeTimers();
    mockSetStatus.mockResolvedValue(noContent());
    mockDeleteTenant.mockResolvedValue(fail(500, 'boom'));

    const promise = orchestrator.deleteTenant(tenantId).catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    expect(await promise).toMatchObject({
      message: `Failed to delete forge tenant ${tenantId}`,
    });
    // 1 initial + 3 retries
    expect(mockDeleteTenant).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
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
  beforeEach(stubS3Credentials);

  it('issues a DeleteBucketCommand against the tenant S3 gateway', async () => {
    s3Mock.on(DeleteBucketCommand).resolves({});

    await orchestrator.deleteBucket(tenantId, 'my-bucket');

    const calls = s3Mock.commandCalls(DeleteBucketCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toMatchObject({ Bucket: 'my-bucket' });
  });

  it('resolves when the delete succeeds', async () => {
    s3Mock.on(DeleteBucketCommand).resolves({});

    await expect(orchestrator.deleteBucket(tenantId, 'my-bucket')).resolves.toBeUndefined();
  });

  // s3DeleteBucket swallows NoSuchBucket, so an already-gone bucket is a success.
  it('treats a NoSuchBucket error as an idempotent success', async () => {
    const err = new Error('no such bucket');
    (err as Error & { name: string }).name = 'NoSuchBucket';
    s3Mock.on(DeleteBucketCommand).rejects(err);

    await expect(orchestrator.deleteBucket(tenantId, 'my-bucket')).resolves.toBeUndefined();
  });

  // Surfaced as a domain error so delete-bucket can answer with a machine-readable
  // 409 (BUCKET_NOT_EMPTY) instead of the generic 500 from errorHandlerMiddleware.
  it('surfaces a BucketNotEmpty error as BucketNotEmptyError', async () => {
    const err = new Error('bucket not empty');
    (err as Error & { name: string }).name = 'BucketNotEmpty';
    s3Mock.on(DeleteBucketCommand).rejects(err);

    await expect(orchestrator.deleteBucket(tenantId, 'my-bucket')).rejects.toBeInstanceOf(
      BucketNotEmptyError,
    );
  });
});

describe('listBuckets', () => {
  it('maps S3 gateway buckets to summaries without a per-bucket versioning read', async () => {
    stubS3Credentials();
    s3Mock.on(ListBucketsCommand).resolves({
      Buckets: [{ Name: 'bucket-a', CreationDate: new Date('2026-01-01T00:00:00Z') }],
    });
    // If this were consulted the result would carry `versioning`; the listing
    // must not call it at all.
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });

    const result = await orchestrator.listBuckets(tenantId);

    expect(s3Mock.commandCalls(GetBucketVersioningCommand)).toHaveLength(0);
    expect(result).toEqual([
      {
        bucketName: 'bucket-a',
        region: S3Region.UsEast1,
        createdAt: '2026-01-01T00:00:00.000Z',
        isPublic: false,
        encrypted: true,
      },
    ]);
  });
});

describe('member credentials on an iam region', () => {
  const iamOrchestrator = buildOrchestrator({ accessModel: 'iam' });
  const member = 'user-1';
  const memberPath = `/filone/test/forge-s3/member-key/${tenantId}/${member}`;
  const notFound = Object.assign(new Error('not found'), { name: 'ParameterNotFound' });

  const issued = (accessKeyId: string) => ({
    data: {
      accessKeyId,
      secretAccessKey: `secret-${accessKeyId}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      principal: member,
    },
    error: undefined,
    response: { status: 201 },
  });

  beforeEach(() => {
    mockPutPrincipal.mockReturnValue(noContent(201));
    ssmMock.on(PutParameterCommand).resolves({});
  });

  it('signs with the tenant key when no member is named', async () => {
    stubS3Credentials();

    const ctx = await iamOrchestrator.getS3ClientContext(tenantId);

    expect(ctx.credentials).toStrictEqual({ accessKeyId: 'AK1', secretAccessKey: 'SK1' });
    expect(mockCreateAccessKey).not.toHaveBeenCalled();
  });

  it('reads the named member credential from its own parameter', async () => {
    ssmMock.on(GetParameterCommand, { Name: memberPath }).resolves({
      Parameter: { Value: JSON.stringify({ accessKeyId: 'AKM', secretAccessKey: 'SKM' }) },
    });

    const ctx = await iamOrchestrator.getS3ClientContext(tenantId, { actAs: member });

    expect(ctx.credentials).toStrictEqual({ accessKeyId: 'AKM', secretAccessKey: 'SKM' });
    // Everything else about the context is the tenant's.
    expect(ctx).toMatchObject({ orchestratorId: 'forge', tenantId, forcePathStyle: true });
  });

  it('registers the principal and mints the key on first use', async () => {
    ssmMock.on(GetParameterCommand).rejects(notFound);
    mockCreateAccessKey.mockReturnValue(issued('AKNEW'));

    const ctx = await iamOrchestrator.getS3ClientContext(tenantId, { actAs: member });

    expect(mockPutPrincipal).toHaveBeenCalledWith(
      expect.objectContaining({ path: { tenantId, principalId: member } }),
    );
    expect(mockCreateAccessKey).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { name: `filone-console/${member}`, principalId: member, expiresAt: null },
      }),
    );
    expect(ctx.credentials).toStrictEqual({
      accessKeyId: 'AKNEW',
      secretAccessKey: 'secret-AKNEW',
    });
    const [put] = ssmMock.commandCalls(PutParameterCommand);
    expect(put!.args[0]!.input).toMatchObject({ Name: memberPath, Type: 'SecureString' });
  });

  it('recovers a key whose secret was never stored', async () => {
    ssmMock.on(GetParameterCommand).rejects(notFound);
    // The mint collides on the deterministic name: a previous request died
    // between creating the key and writing its secret.
    mockCreateAccessKey.mockReturnValueOnce(fail(409)).mockReturnValue(issued('AKFRESH'));
    mockListAccessKeys.mockReturnValue({
      data: {
        items: [
          {
            accessKeyId: 'AKORPHAN',
            name: `filone-console/${member}`,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
      error: undefined,
      response: { status: 200 },
    });
    mockDeleteAccessKey.mockReturnValue(noContent());

    const ctx = await iamOrchestrator.getS3ClientContext(tenantId, { actAs: member });

    expect(mockDeleteAccessKey).toHaveBeenCalledWith(
      expect.objectContaining({ path: { tenantId, accessKeyId: 'AKORPHAN' } }),
    );
    expect(ctx.credentials.accessKeyId).toBe('AKFRESH');
  });

  it('propagates the conflict when no key of that name is listed', async () => {
    ssmMock.on(GetParameterCommand).rejects(notFound);
    mockCreateAccessKey.mockReturnValue(fail(409));
    mockListAccessKeys.mockReturnValue({
      data: { items: [] },
      error: undefined,
      response: { status: 200 },
    });

    await expect(
      iamOrchestrator.getS3ClientContext(tenantId, { actAs: member }),
    ).rejects.toBeInstanceOf(AccessKeyAlreadyExistsError);
    expect(mockDeleteAccessKey).not.toHaveBeenCalled();
  });

  it('ignores the named member on a scoped-keys region', async () => {
    stubS3Credentials();

    const ctx = await orchestrator.getS3ClientContext(tenantId, { actAs: member });

    expect(ctx.credentials).toStrictEqual({ accessKeyId: 'AK1', secretAccessKey: 'SK1' });
    expect(mockCreateAccessKey).not.toHaveBeenCalled();
    expect(mockPutPrincipal).not.toHaveBeenCalled();
  });

  describe('getBucket signed as the member', () => {
    function storedCredential() {
      ssmMock.on(GetParameterCommand, { Name: memberPath }).resolves({
        Parameter: { Value: JSON.stringify({ accessKeyId: 'AKM', secretAccessKey: 'SKM' }) },
      });
      s3Mock.on(GetObjectLockConfigurationCommand).resolves({});
    }

    it('signs the bucket-addressed reads with the member credential', async () => {
      storedCredential();
      s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });

      await expect(
        iamOrchestrator.getBucket(tenantId, 'bucket-a', { actAs: member }),
      ).resolves.toMatchObject({ bucketName: 'bucket-a' });
      expect(s3Mock.commandCalls(ListBucketsCommand)).toHaveLength(0);
    });

    it('answers null for a bucket the member cannot reach', async () => {
      storedCredential();
      // A bucket outside their policies is refused, and reads exactly like a
      // bucket that does not exist.
      s3Mock
        .on(GetBucketVersioningCommand)
        .rejects(new NoSuchBucket({ message: 'no such bucket', $metadata: {} }));

      await expect(
        iamOrchestrator.getBucket(tenantId, 'other', { actAs: member }),
      ).resolves.toBeNull();
    });

    it('evicts and retries once when the credential is refused', async () => {
      storedCredential();
      const refused = Object.assign(new Error('bad key'), { name: 'InvalidAccessKeyId' });
      s3Mock.on(GetBucketVersioningCommand).rejectsOnce(refused).resolves({ Status: 'Enabled' });

      await expect(
        iamOrchestrator.getBucket(tenantId, 'bucket-a', { actAs: member }),
      ).resolves.toMatchObject({ bucketName: 'bucket-a' });
      // Evicted, so the second attempt goes back to SSM rather than reusing the
      // credential that was just refused.
      expect(ssmMock.commandCalls(GetParameterCommand, { Name: memberPath })).toHaveLength(2);
    });

    it('gives up after a second refusal', async () => {
      storedCredential();
      const refused = Object.assign(new Error('bad key'), { name: 'InvalidAccessKeyId' });
      s3Mock.on(GetBucketVersioningCommand).rejects(refused);

      await expect(
        iamOrchestrator.getBucket(tenantId, 'bucket-a', { actAs: member }),
      ).rejects.toThrow('bad key');
    });
  });
});

describe('listBuckets on an iam region', () => {
  const iamOrchestrator = buildOrchestrator({ accessModel: 'iam' });
  const member = 'user-1';

  // Two buckets exist in the tenant; the gateway returns both whatever key
  // signs, because every principal holds `s3:ListAllMyBuckets`.
  function stubTenantListing() {
    stubS3Credentials();
    s3Mock.on(ListBucketsCommand).resolves({
      Buckets: [
        { Name: 'photos', CreationDate: new Date('2026-01-01T00:00:00Z') },
        { Name: 'backups', CreationDate: new Date('2026-01-02T00:00:00Z') },
      ],
    });
  }

  const reaches = (...names: string[]) => ({
    data: { buckets: names.map((name) => ({ name, actions: ['s3:ListBucket'] })) },
    error: undefined,
    response: { status: 200 },
  });

  it('keeps only the buckets the member reaches', async () => {
    stubTenantListing();
    mockGetPrincipalAccess.mockReturnValue(reaches('photos'));

    const result = await iamOrchestrator.listBuckets(tenantId, { actAs: member });

    expect(result.map((b) => b.bucketName)).toStrictEqual(['photos']);
    expect(mockGetPrincipalAccess).toHaveBeenCalledWith(
      expect.objectContaining({ path: { tenantId, principalId: member } }),
    );
  });

  it('returns the tenant listing untouched when no member is named', async () => {
    stubTenantListing();

    const result = await iamOrchestrator.listBuckets(tenantId);

    // The fence for the roster fan-out, the usage handler and the activity
    // feed: they omit `actAs` and must keep seeing every bucket.
    expect(result.map((b) => b.bucketName)).toStrictEqual(['photos', 'backups']);
    expect(mockGetPrincipalAccess).not.toHaveBeenCalled();
  });

  it('rejects rather than answering unfiltered when the access lookup fails', async () => {
    stubTenantListing();
    mockGetPrincipalAccess.mockReturnValue(fail(503));

    // The caller's fan-out turns this into an unavailable region. Returning the
    // tenant listing here would hand the member every bucket name it holds.
    await expect(iamOrchestrator.listBuckets(tenantId, { actAs: member })).rejects.toThrow();
  });

  it('answers with an empty list for a member who reaches nothing', async () => {
    stubTenantListing();
    mockGetPrincipalAccess.mockReturnValue(reaches());

    await expect(iamOrchestrator.listBuckets(tenantId, { actAs: member })).resolves.toStrictEqual(
      [],
    );
  });

  it('ignores the named member on a scoped-keys region', async () => {
    stubTenantListing();

    const result = await orchestrator.listBuckets(tenantId, { actAs: member });

    expect(result.map((b) => b.bucketName)).toStrictEqual(['photos', 'backups']);
    expect(mockGetPrincipalAccess).not.toHaveBeenCalled();
  });
});

describe('getBucket', () => {
  beforeEach(stubS3Credentials);

  const noSuchBucket = () =>
    new NoSuchBucket({ message: 'The specified bucket does not exist', $metadata: {} });

  it('proves existence without listing the tenant', async () => {
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    s3Mock.on(GetObjectLockConfigurationCommand).resolves({});

    await orchestrator.getBucket(tenantId, 'bucket-a');

    // The listing answered for the tenant, so it said yes for a bucket the
    // caller could not open, and cost a call per bucket to answer about one.
    expect(s3Mock.commandCalls(ListBucketsCommand)).toHaveLength(0);
  });

  it('returns null when the versioning read says the bucket is not there', async () => {
    s3Mock.on(GetBucketVersioningCommand).rejects(noSuchBucket());
    s3Mock.on(GetObjectLockConfigurationCommand).resolves({});

    await expect(orchestrator.getBucket(tenantId, 'missing')).resolves.toBeNull();
  });

  it('returns null when the object-lock read says the bucket is not there', async () => {
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    s3Mock.on(GetObjectLockConfigurationCommand).rejects(noSuchBucket());

    await expect(orchestrator.getBucket(tenantId, 'missing')).resolves.toBeNull();
  });

  it('keeps object lock off for a bucket that simply has no configuration', async () => {
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    s3Mock
      .on(GetObjectLockConfigurationCommand)
      .rejects(
        Object.assign(new Error('no config'), { name: 'ObjectLockConfigurationNotFoundError' }),
      );

    await expect(orchestrator.getBucket(tenantId, 'bucket-a')).resolves.toMatchObject({
      objectLockEnabled: false,
    });
  });

  it('returns details including object-lock state', async () => {
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    s3Mock.on(GetObjectLockConfigurationCommand).resolves({
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 7 } },
      },
    });

    const result = await orchestrator.getBucket(tenantId, 'bucket-a');

    // No createdAt: S3 carries no creation date for a single bucket, and the
    // listing that did carry one is gone.
    expect(result).toEqual({
      bucketName: 'bucket-a',
      region: S3Region.UsEast1,
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

describe('signal forwarding', () => {
  // The caller's deadline. Never aborted here: these tests check it is forwarded,
  // not what happens when it fires.
  const signal = new AbortController().signal;
  const range = { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' };

  // aws-sdk-client-mock types `args` as the one-element `[command]` tuple,
  // but the recorded sinon call carries every argument `send` received.
  function sendOptionsOf(calls: Array<{ args: unknown[] }>): unknown {
    return calls[0].args[1];
  }

  beforeEach(stubS3Credentials);

  // Each case names the Management API mocks the method must reach; the test
  // checks every one of them received the caller's signal in its options.
  const managementCases: Array<{
    name: string;
    run: (requestOptions: OrchestratorRequestOptions) => Promise<unknown>;
    mocks: Array<{ mock: { calls: unknown[][] } }>;
  }> = [
    {
      name: 'updateTenantStatus',
      run: (requestOptions) => {
        mockSetStatus.mockResolvedValue(noContent());
        return orchestrator.updateTenantStatus(tenantId, 'active', requestOptions);
      },
      mocks: [mockSetStatus],
    },
    {
      name: 'deleteTenant',
      run: (requestOptions) => {
        mockSetStatus.mockResolvedValue(noContent());
        mockDeleteTenant.mockResolvedValue(noContent());
        return orchestrator.deleteTenant(tenantId, requestOptions);
      },
      mocks: [mockSetStatus, mockDeleteTenant],
    },
    {
      name: 'getTenantStatus',
      run: (requestOptions) => {
        mockGetTenant.mockResolvedValue(ok({ status: 'active' }));
        return orchestrator.getTenantStatus(tenantId, requestOptions);
      },
      mocks: [mockGetTenant],
    },
    {
      name: 'issueAccessKey',
      run: (requestOptions) => {
        mockCreateAccessKey.mockResolvedValue(
          ok({ accessKeyId: 'AK', secretAccessKey: 'SK', createdAt: '2026-01-01T00:00:00Z' }, 201),
        );
        return orchestrator.issueAccessKey(
          tenantId,
          { keyName: 'k', permissions: ['read'] },
          requestOptions,
        );
      },
      mocks: [mockCreateAccessKey],
    },
    {
      name: 'findAccessKeyByName',
      run: (requestOptions) => {
        mockListAccessKeys.mockResolvedValue(ok({ items: [] }));
        return orchestrator.findAccessKeyByName(tenantId, 'k', requestOptions);
      },
      mocks: [mockListAccessKeys],
    },
    {
      name: 'deleteAccessKey',
      run: (requestOptions) => {
        mockDeleteAccessKey.mockResolvedValue(noContent());
        return orchestrator.deleteAccessKey(tenantId, 'AK', requestOptions);
      },
      mocks: [mockDeleteAccessKey],
    },
    {
      name: 'getTenantUsageMetrics',
      run: (requestOptions) => {
        mockGetTenantMetrics.mockResolvedValue(ok(emptyMetrics));
        return orchestrator.getTenantUsageMetrics(tenantId, range, requestOptions);
      },
      mocks: [mockGetTenantMetrics],
    },
    {
      name: 'getTenantInfo',
      run: (requestOptions) => {
        mockGetTenant.mockResolvedValue(ok({ status: 'active' }));
        return orchestrator.getTenantInfo(tenantId, requestOptions);
      },
      mocks: [mockGetTenant],
    },
    {
      name: 'getBucketUsageMetrics',
      run: (requestOptions) => {
        mockGetBucketMetrics.mockResolvedValue(ok(emptyMetrics));
        return orchestrator.getBucketUsageMetrics(tenantId, 'b', range, requestOptions);
      },
      mocks: [mockGetBucketMetrics],
    },
  ];

  for (const { name, run, mocks } of managementCases) {
    it(`${name} passes the caller's signal to every Management API call`, async () => {
      await run({ signal });

      const firstArgs = mocks.map((m) => m.mock.calls[0]?.[0]);
      expect(firstArgs).toEqual(mocks.map(() => expect.objectContaining({ signal })));
    });
  }

  it('getS3ClientContext forwards the signal to the SSM credential read', async () => {
    await orchestrator.getS3ClientContext(tenantId, { signal });

    expect(sendOptionsOf(ssmMock.commandCalls(GetParameterCommand))).toEqual({
      abortSignal: signal,
    });
  });

  it('listBuckets forwards the signal to S3 ListBuckets', async () => {
    s3Mock.on(ListBucketsCommand).resolves({ Buckets: [] });

    await orchestrator.listBuckets(tenantId, { signal });

    expect(sendOptionsOf(s3Mock.commandCalls(ListBucketsCommand))).toEqual({
      abortSignal: signal,
    });
  });

  it('deleteBucket forwards the signal to S3 DeleteBucket', async () => {
    s3Mock.on(DeleteBucketCommand).resolves({});

    await orchestrator.deleteBucket(tenantId, 'b', { signal });

    expect(sendOptionsOf(s3Mock.commandCalls(DeleteBucketCommand))).toEqual({
      abortSignal: signal,
    });
  });

  it('getBucket forwards the signal to both per-bucket reads', async () => {
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    s3Mock.on(GetObjectLockConfigurationCommand).resolves({});

    await orchestrator.getBucket(tenantId, 'b', { signal });

    const sent = [
      sendOptionsOf(s3Mock.commandCalls(GetBucketVersioningCommand)),
      sendOptionsOf(s3Mock.commandCalls(GetObjectLockConfigurationCommand)),
    ];
    expect(sent).toEqual([{ abortSignal: signal }, { abortSignal: signal }]);
  });

  it('createBucket forwards the signal to CreateBucket and both configuration calls', async () => {
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutBucketVersioningCommand).resolves({});
    s3Mock.on(PutObjectLockConfigurationCommand).resolves({});

    await orchestrator.createBucket(
      tenantId,
      {
        bucketName: 'b',
        versioning: true,
        lock: true,
        retention: { enabled: true, mode: 'governance', duration: 1, durationType: 'd' },
      },
      { signal },
    );

    const sent = [
      sendOptionsOf(s3Mock.commandCalls(CreateBucketCommand)),
      sendOptionsOf(s3Mock.commandCalls(PutBucketVersioningCommand)),
      sendOptionsOf(s3Mock.commandCalls(PutObjectLockConfigurationCommand)),
    ];
    expect(sent).toEqual([
      { abortSignal: signal },
      { abortSignal: signal },
      { abortSignal: signal },
    ]);
  });
});
