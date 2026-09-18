import { describe, it, expect, vi, beforeEach } from 'vitest';
import { S3Region } from '@filone/shared';
import type { BucketPolicy } from '@filone/shared';

vi.mock('sst', () => ({ Resource: { UserInfoTable: { name: 'UserInfoTable' } } }));

// The generated SDK is mocked at the module boundary; each operation answers
// the hey-api `{ data, error, response }` shape. The policy operations go over
// S3 and are mocked at the S3 operations module instead; the console
// credential lookup behind them is stubbed so no client reaches SSM.
const mockPutPrincipal = vi.fn((_o: Record<string, unknown>) => ({}));
const mockDeletePrincipal = vi.fn((_o: Record<string, unknown>) => ({}));
const mockGetPolicy = vi.fn((..._a: unknown[]): unknown => null);
const mockPutPolicy = vi.fn((..._a: unknown[]): unknown => ({}));
const mockDeletePolicy = vi.fn((..._a: unknown[]): unknown => undefined);
const mockPrincipalPolicies = vi.fn((_o: Record<string, unknown>) => ({}));
const mockPrincipalAccess = vi.fn((_o: Record<string, unknown>) => ({}));
const mockCreateAccessKey = vi.fn((_o: Record<string, unknown>) => ({}));

vi.mock('@filone/orchestrator-client', () => ({
  createClient: () => 'mock-client',
  putTenantsByTenantIdPrincipalsByPrincipalId: (o: Record<string, unknown>) => mockPutPrincipal(o),
  deleteTenantsByTenantIdPrincipalsByPrincipalId: (o: Record<string, unknown>) =>
    mockDeletePrincipal(o),
  getTenantsByTenantIdPrincipalsByPrincipalIdPolicies: (o: Record<string, unknown>) =>
    mockPrincipalPolicies(o),
  getTenantsByTenantIdPrincipalsByPrincipalIdAccess: (o: Record<string, unknown>) =>
    mockPrincipalAccess(o),
  postTenantsByTenantIdAccessKeys: (o: Record<string, unknown>) => mockCreateAccessKey(o),
}));
vi.mock('./metrics.ts', () => ({ instrumentClient: vi.fn() }));
vi.mock('../s3-bucket-operations.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../s3-bucket-operations.ts')>()),
  getBucketPolicy: (...a: unknown[]) => mockGetPolicy(...a),
  putBucketPolicy: (...a: unknown[]) => mockPutPolicy(...a),
  deleteBucketPolicy: (...a: unknown[]) => mockDeletePolicy(...a),
}));
vi.mock('../s3-credentials.ts', () => ({
  getConsoleS3Credentials: async () => ({
    accessKeyId: 'AKIA0000TESTKEY0',
    secretAccessKey: 'secret',
  }),
}));

import {
  PolicyConflictError,
  PolicyPreconditionFailedError,
  PolicyPublishError,
  PolicyValidationError,
  PrincipalNotFoundError,
} from '../errors.ts';
import { createFilOneOrchestrator } from './arms.ts';

const tenantId = '00000000-0000-0000-0000-000000000001';
const policy: BucketPolicy = {
  Statement: [{ Effect: 'Allow', Principal: ['alice'], Action: ['s3:GetObject'] }],
};

function respond(
  status: number,
  data?: unknown,
  error?: unknown,
  headers: Record<string, string> = {},
) {
  return { data, error, response: { status, headers: new Headers(headers) } };
}
const ok = (data: unknown, status = 200, headers?: Record<string, string>) =>
  respond(status, data, undefined, headers);
const fail = (status: number, body: unknown = { message: 'error' }) =>
  respond(status, undefined, body);

function buildIam() {
  const orchestrator = createFilOneOrchestrator({
    id: 'forge',
    region: S3Region.UsEast9,
    stage: 'test',
    s3EndpointUrl: 'https://s3.example.test',
    api: { baseUrl: 'https://api.example.test', accessToken: 'partner-key' },
    accessModel: 'iam',
  });
  if (orchestrator.accessModel !== 'iam') throw new Error('expected the iam arm');
  return orchestrator;
}

const orchestrator = buildIam();
const iam = orchestrator.iam;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the access model', () => {
  it('attaches the iam arm only when asked for it', () => {
    expect(orchestrator.accessModel).toBe('iam');
    const scoped = createFilOneOrchestrator({
      id: 'forge',
      region: S3Region.EuCentral3,
      stage: 'test',
      s3EndpointUrl: 'https://s3.example.test',
      api: { baseUrl: 'https://api.example.test', accessToken: 'partner-key' },
    });
    expect(scoped.accessModel).toBe('scoped-keys');
    expect('iam' in scoped).toBe(false);
  });
});

describe('getBucketPolicy', () => {
  it('reads over S3 as the tenant and returns what the operation answered', async () => {
    mockGetPolicy.mockResolvedValue({ policy, etag: '"abc"' });

    await expect(iam.getBucketPolicy(tenantId, 'photos')).resolves.toStrictEqual({
      policy,
      etag: '"abc"',
    });
    expect(mockGetPolicy).toHaveBeenCalledWith(expect.any(Object), 'photos');
  });

  it('passes a bucket without a policy through as null', async () => {
    mockGetPolicy.mockResolvedValue(null);
    await expect(iam.getBucketPolicy(tenantId, 'photos')).resolves.toBeNull();
  });
});

describe('putBucketPolicy', () => {
  it('replaces under If-Match and reports the new ETag', async () => {
    mockPutPolicy.mockResolvedValue({ etag: '"v2"' });

    await expect(
      iam.putBucketPolicy(tenantId, 'photos', policy, { ifMatch: '"v1"' }),
    ).resolves.toStrictEqual({ etag: '"v2"' });
    expect(mockPutPolicy).toHaveBeenCalledWith(expect.any(Object), 'photos', policy, {
      ifMatch: '"v1"',
    });
  });

  it('creates under If-None-Match: *', async () => {
    mockPutPolicy.mockResolvedValue({ etag: '"v1"' });

    await expect(
      iam.putBucketPolicy(tenantId, 'photos', policy, { ifNoneMatch: '*' }),
    ).resolves.toStrictEqual({ etag: '"v1"' });
    expect(mockPutPolicy).toHaveBeenCalledWith(expect.any(Object), 'photos', policy, {
      ifNoneMatch: '*',
    });
  });

  it('does not retry a stale ETag: the caller has to read again', async () => {
    mockPutPolicy.mockRejectedValue(new PolicyPreconditionFailedError('photos'));

    await expect(
      iam.putBucketPolicy(tenantId, 'photos', policy, { ifMatch: '"old"' }),
    ).rejects.toBeInstanceOf(PolicyPreconditionFailedError);
    expect(mockPutPolicy).toHaveBeenCalledTimes(1);
  });

  it('retries a lock timeout and succeeds on the next attempt', async () => {
    mockPutPolicy
      .mockRejectedValueOnce(new PolicyConflictError())
      .mockResolvedValueOnce({ etag: '"v2"' });

    await expect(
      iam.putBucketPolicy(tenantId, 'photos', policy, { ifMatch: '"v1"' }),
    ).resolves.toStrictEqual({ etag: '"v2"' });
    expect(mockPutPolicy).toHaveBeenCalledTimes(2);
  });

  it('retries a failed publish and gives up with the retryable error', async () => {
    mockPutPolicy.mockRejectedValue(new PolicyPublishError());

    await expect(
      iam.putBucketPolicy(tenantId, 'photos', policy, { ifMatch: '"v1"' }),
    ).rejects.toBeInstanceOf(PolicyPublishError);
    expect(mockPutPolicy).toHaveBeenCalledTimes(3);
  });

  it('surfaces the storage system’s validation message once, without retrying', async () => {
    mockPutPolicy.mockRejectedValue(new PolicyValidationError('unknown principal "bob"'));

    const err: unknown = await iam
      .putBucketPolicy(tenantId, 'photos', policy, { ifMatch: '"v1"' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyValidationError);
    expect((err as Error).message).toBe('unknown principal "bob"');
    expect(mockPutPolicy).toHaveBeenCalledTimes(1);
  });

  it('maps a conflict that never clears to PolicyConflictError', async () => {
    mockPutPolicy.mockRejectedValue(new PolicyConflictError());
    await expect(
      iam.putBucketPolicy(tenantId, 'photos', policy, { ifMatch: '"v1"' }),
    ).rejects.toBeInstanceOf(PolicyConflictError);
  });
});

describe('deleteBucketPolicy', () => {
  it('deletes under If-Match as the tenant', async () => {
    mockDeletePolicy.mockResolvedValue(undefined);
    await expect(
      iam.deleteBucketPolicy(tenantId, 'photos', { ifMatch: '"v1"' }),
    ).resolves.toBeUndefined();
    expect(mockDeletePolicy).toHaveBeenCalledWith(expect.any(Object), 'photos', {
      ifMatch: '"v1"',
    });
  });
});

describe('principals', () => {
  it('syncMember accepts both the created and the already-there answers', async () => {
    mockPutPrincipal.mockResolvedValueOnce(ok({ principalId: 'alice' }, 201));
    await expect(iam.syncMember(tenantId, 'alice')).resolves.toBeUndefined();
    mockPutPrincipal.mockResolvedValueOnce(ok({ principalId: 'alice' }, 200));
    await expect(iam.syncMember(tenantId, 'alice')).resolves.toBeUndefined();
    expect(mockPutPrincipal).toHaveBeenCalledWith(
      expect.objectContaining({ path: { tenantId, principalId: 'alice' } }),
    );
  });

  it('syncMember surfaces a refused id as a validation error', async () => {
    mockPutPrincipal.mockResolvedValue(fail(422, { message: 'invalid principal id' }));
    await expect(iam.syncMember(tenantId, '*')).rejects.toBeInstanceOf(PolicyValidationError);
  });

  it('removeMember treats 204 as done and a missing tenant as a failure', async () => {
    mockDeletePrincipal.mockResolvedValueOnce(respond(204));
    await expect(iam.removeMember(tenantId, 'alice')).resolves.toBeUndefined();
    mockDeletePrincipal.mockResolvedValueOnce(fail(404));
    await expect(iam.removeMember(tenantId, 'alice')).rejects.toBeInstanceOf(
      PrincipalNotFoundError,
    );
  });

  it('lists the policies naming a member and resolves their access', async () => {
    mockPrincipalPolicies.mockResolvedValue(ok({ items: [{ bucketName: 'photos', policy }] }));
    mockPrincipalAccess.mockResolvedValue(
      ok({ buckets: [{ name: 'photos', actions: ['s3:GetObject'] }] }),
    );

    await expect(iam.listBucketPoliciesForMember(tenantId, 'alice')).resolves.toStrictEqual([
      { bucketName: 'photos', policy },
    ]);
    await expect(iam.resolveMemberAccess(tenantId, 'alice')).resolves.toStrictEqual([
      { bucketName: 'photos', actions: ['s3:GetObject'] },
    ]);
  });
});
