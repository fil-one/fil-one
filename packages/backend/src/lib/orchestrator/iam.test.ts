import { describe, it, expect, vi, beforeEach } from 'vitest';
import { S3Region } from '@filone/shared';
import type { BucketPolicy } from '@filone/shared';

vi.mock('sst', () => ({ Resource: { UserInfoTable: { name: 'UserInfoTable' } } }));

// The generated SDK is mocked at the module boundary; each operation answers
// the hey-api `{ data, error, response }` shape, and the response carries the
// headers the ETag protocol reads.
const mockPutPrincipal = vi.fn((_o: Record<string, unknown>) => ({}));
const mockDeletePrincipal = vi.fn((_o: Record<string, unknown>) => ({}));
const mockGetPolicy = vi.fn((_o: Record<string, unknown>) => ({}));
const mockPutPolicy = vi.fn((_o: Record<string, unknown>) => ({}));
const mockDeletePolicy = vi.fn((_o: Record<string, unknown>) => ({}));
const mockPrincipalPolicies = vi.fn((_o: Record<string, unknown>) => ({}));
const mockPrincipalAccess = vi.fn((_o: Record<string, unknown>) => ({}));
const mockCreateAccessKey = vi.fn((_o: Record<string, unknown>) => ({}));

vi.mock('@filone/orchestrator-client', () => ({
  createClient: () => 'mock-client',
  putTenantsByTenantIdPrincipalsByPrincipalId: (o: Record<string, unknown>) => mockPutPrincipal(o),
  deleteTenantsByTenantIdPrincipalsByPrincipalId: (o: Record<string, unknown>) =>
    mockDeletePrincipal(o),
  getTenantsByTenantIdBucketsByBucketNamePolicy: (o: Record<string, unknown>) => mockGetPolicy(o),
  putTenantsByTenantIdBucketsByBucketNamePolicy: (o: Record<string, unknown>) => mockPutPolicy(o),
  deleteTenantsByTenantIdBucketsByBucketNamePolicy: (o: Record<string, unknown>) =>
    mockDeletePolicy(o),
  getTenantsByTenantIdPrincipalsByPrincipalIdPolicies: (o: Record<string, unknown>) =>
    mockPrincipalPolicies(o),
  getTenantsByTenantIdPrincipalsByPrincipalIdAccess: (o: Record<string, unknown>) =>
    mockPrincipalAccess(o),
  postTenantsByTenantIdAccessKeys: (o: Record<string, unknown>) => mockCreateAccessKey(o),
}));
vi.mock('./metrics.ts', () => ({ instrumentClient: vi.fn() }));

import {
  AccessKeyAlreadyExistsError,
  BucketNotFoundError,
  PolicyConflictError,
  PolicyPreconditionFailedError,
  PolicyPublishError,
  PolicyValidationError,
  PrincipalNotFoundError,
} from '../errors.ts';
import { createFilOneOrchestrator } from './arms.ts';

const tenantId = '00000000-0000-0000-0000-000000000001';
const policy: BucketPolicy = {
  statement: [{ effect: 'allow', principal: ['alice'], action: ['s3:GetObject'] }],
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
  it('returns the document with the ETag the storage system sent', async () => {
    mockGetPolicy.mockResolvedValue(ok(policy, 200, { etag: '"abc"' }));

    await expect(iam.getBucketPolicy(tenantId, 'photos')).resolves.toStrictEqual({
      policy,
      etag: '"abc"',
    });
    expect(mockGetPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ path: { tenantId, bucketName: 'photos' } }),
    );
  });

  it('answers null for a bucket with no policy and throws for a bucket that is not there', async () => {
    mockGetPolicy.mockResolvedValueOnce(
      fail(404, { message: 'no policy', code: 'PolicyNotFound' }),
    );
    await expect(iam.getBucketPolicy(tenantId, 'photos')).resolves.toBeNull();

    // A message that merely mentions the policy route is a bucket that is not there.
    mockGetPolicy.mockResolvedValueOnce(fail(404, { message: 'bucket policy: bucket not found' }));
    await expect(iam.getBucketPolicy(tenantId, 'photos')).rejects.toBeInstanceOf(
      BucketNotFoundError,
    );
  });

  it('refuses a 200 that carries no ETag', async () => {
    mockGetPolicy.mockResolvedValue(ok(policy));
    await expect(iam.getBucketPolicy(tenantId, 'photos')).rejects.toThrow(/without an ETag/);
  });
});

describe('putBucketPolicy', () => {
  it('sends If-Match to replace and reports the new ETag', async () => {
    mockPutPolicy.mockResolvedValue(ok(undefined, 200, { etag: '"v2"' }));

    await expect(
      iam.putBucketPolicy(tenantId, 'photos', policy, { ifMatch: '"v1"' }),
    ).resolves.toStrictEqual({ etag: '"v2"', created: false });
    expect(mockPutPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { 'If-Match': '"v1"' }, body: policy }),
    );
  });

  it('sends If-None-Match: * to create and reports created on a 201', async () => {
    mockPutPolicy.mockResolvedValue(ok(undefined, 201, { etag: '"v1"' }));

    await expect(
      iam.putBucketPolicy(tenantId, 'photos', policy, { ifNoneMatch: '*' }),
    ).resolves.toStrictEqual({ etag: '"v1"', created: true });
    expect(mockPutPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { 'If-None-Match': '*' } }),
    );
  });

  it('does not retry a stale ETag: the caller has to read again', async () => {
    mockPutPolicy.mockResolvedValue(fail(412));

    await expect(
      iam.putBucketPolicy(tenantId, 'photos', policy, { ifMatch: '"old"' }),
    ).rejects.toBeInstanceOf(PolicyPreconditionFailedError);
    expect(mockPutPolicy).toHaveBeenCalledTimes(1);
  });

  it('retries a lock timeout and succeeds on the next attempt', async () => {
    mockPutPolicy
      .mockResolvedValueOnce(fail(409, { message: 'ConcurrentChange' }))
      .mockResolvedValueOnce(ok(undefined, 200, { etag: '"v2"' }));

    await expect(
      iam.putBucketPolicy(tenantId, 'photos', policy, { ifMatch: '"v1"' }),
    ).resolves.toStrictEqual({ etag: '"v2"', created: false });
    expect(mockPutPolicy).toHaveBeenCalledTimes(2);
  });

  it('retries a failed publish and gives up with the retryable error', async () => {
    mockPutPolicy.mockResolvedValue(fail(500));

    await expect(
      iam.putBucketPolicy(tenantId, 'photos', policy, { ifMatch: '"v1"' }),
    ).rejects.toBeInstanceOf(PolicyPublishError);
    expect(mockPutPolicy).toHaveBeenCalledTimes(3);
  });

  it('surfaces the storage system’s validation message once, without retrying', async () => {
    mockPutPolicy.mockResolvedValue(fail(422, { message: 'unknown principal "bob"' }));

    const err: unknown = await iam
      .putBucketPolicy(tenantId, 'photos', policy, { ifMatch: '"v1"' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyValidationError);
    expect((err as Error).message).toBe('unknown principal "bob"');
    expect(mockPutPolicy).toHaveBeenCalledTimes(1);
  });

  it('maps a 409 that never clears to PolicyConflictError', async () => {
    mockPutPolicy.mockResolvedValue(fail(409));
    await expect(
      iam.putBucketPolicy(tenantId, 'photos', policy, { ifMatch: '"v1"' }),
    ).rejects.toBeInstanceOf(PolicyConflictError);
  });
});

describe('deleteBucketPolicy', () => {
  it('sends If-Match and treats 204 as done', async () => {
    mockDeletePolicy.mockResolvedValue(respond(204));
    await expect(
      iam.deleteBucketPolicy(tenantId, 'photos', { ifMatch: '"v1"' }),
    ).resolves.toBeUndefined();
    expect(mockDeletePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { 'If-Match': '"v1"' } }),
    );
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
    mockPrincipalPolicies.mockResolvedValue(
      ok({ items: [{ bucketName: 'photos', etag: '"v1"', policy }] }),
    );
    mockPrincipalAccess.mockResolvedValue(
      ok({ buckets: [{ name: 'photos', actions: ['s3:GetObject'] }] }),
    );

    await expect(iam.listBucketPoliciesForMember(tenantId, 'alice')).resolves.toStrictEqual([
      { bucketName: 'photos', etag: '"v1"', policy },
    ]);
    await expect(iam.resolveMemberAccess(tenantId, 'alice')).resolves.toStrictEqual([
      { bucketName: 'photos', actions: ['s3:GetObject'] },
    ]);
  });
});

describe('issueMemberKey', () => {
  const created = {
    accessKeyId: 'did:key:z6Mk',
    name: 'laptop',
    principal: 'alice',
    secretAccessKey: 'sk-secret',
    createdAt: '2026-09-16T12:00:00Z',
    expiresAt: null,
  };

  it('sends the principal-bound shape and returns the credential with its principal', async () => {
    mockCreateAccessKey.mockResolvedValue(ok(created, 201));

    await expect(
      iam.issueMemberKey(tenantId, 'alice', { keyName: 'laptop' }),
    ).resolves.toStrictEqual({
      id: 'did:key:z6Mk',
      accessKeyId: 'did:key:z6Mk',
      accessKeySecret: 'sk-secret',
      createdAt: '2026-09-16T12:00:00Z',
      principalId: 'alice',
    });
    const { body } = mockCreateAccessKey.mock.calls[0]![0] as { body: Record<string, unknown> };
    expect(body).toStrictEqual({ name: 'laptop', principalId: 'alice', expiresAt: null });
    expect(body).not.toHaveProperty('permissions');
  });

  it('maps a duplicate name and an unknown principal to their errors', async () => {
    mockCreateAccessKey.mockResolvedValueOnce(fail(409, { message: 'name conflict' }));
    await expect(
      iam.issueMemberKey(tenantId, 'alice', { keyName: 'laptop' }),
    ).rejects.toBeInstanceOf(AccessKeyAlreadyExistsError);

    mockCreateAccessKey.mockResolvedValueOnce(fail(422, { message: 'unknown principal' }));
    await expect(
      iam.issueMemberKey(tenantId, 'alice', { keyName: 'laptop' }),
    ).rejects.toBeInstanceOf(PrincipalNotFoundError);
  });
});
