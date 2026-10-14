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
const mockListPrincipalPolicies = vi.fn((_o: Record<string, unknown>) => ({}));
const mockGetPrincipalAccess = vi.fn((_o: Record<string, unknown>) => ({}));
const mockCreateAccessKey = vi.fn((_o: Record<string, unknown>) => ({}));

vi.mock('@filone/orchestrator-client', () => ({
  createClient: () => 'mock-client',
  putTenantsByTenantIdPrincipalsByPrincipalId: (o: Record<string, unknown>) => mockPutPrincipal(o),
  deleteTenantsByTenantIdPrincipalsByPrincipalId: (o: Record<string, unknown>) =>
    mockDeletePrincipal(o),
  getTenantsByTenantIdPrincipalsByPrincipalIdPolicies: (o: Record<string, unknown>) =>
    mockListPrincipalPolicies(o),
  getTenantsByTenantIdPrincipalsByPrincipalIdAccess: (o: Record<string, unknown>) =>
    mockGetPrincipalAccess(o),
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
} from '../errors.ts';
import { FilOneOrchestrator } from './orchestrator.ts';
import type { PolicyPrecondition } from '../bucket-policy-orchestrator.ts';

const tenantId = '00000000-0000-0000-0000-000000000001';
const policy: BucketPolicy = {
  Statement: [{ Effect: 'Allow', Principal: ['alice'], Action: ['s3:GetObject'] }],
};

// The hey-api SDK resolves every call to `{ data, error, response }` rather than throwing.
function buildSdkResult(
  status: number,
  data?: unknown,
  error?: unknown,
  headers: Record<string, string> = {},
) {
  return { data, error, response: { status, headers: new Headers(headers) } };
}
const ok = (data: unknown, status = 200, headers?: Record<string, string>) =>
  buildSdkResult(status, data, undefined, headers);
const fail = (status: number, body: unknown = { message: 'error' }) =>
  buildSdkResult(status, undefined, body);

const orchestrator = new FilOneOrchestrator({
  id: 'forge',
  region: S3Region.UsEast9,
  stage: 'test',
  s3EndpointUrl: 'https://s3.example.test',
  api: { baseUrl: 'https://api.example.test', accessToken: 'partner-key' },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getBucketPolicy', () => {
  it('returns the policy and ETag the S3 read returned', async () => {
    mockGetPolicy.mockResolvedValue({ policy, etag: '"abc"' });

    await expect(orchestrator.getBucketPolicy(tenantId, 'photos')).resolves.toStrictEqual({
      policy,
      etag: '"abc"',
    });
    expect(mockGetPolicy).toHaveBeenCalledWith(expect.any(Object), 'photos');
  });

  it('returns null when the bucket has no policy', async () => {
    mockGetPolicy.mockResolvedValue(null);
    await expect(orchestrator.getBucketPolicy(tenantId, 'photos')).resolves.toBeNull();
  });
});

describe('putBucketPolicy', () => {
  it('replaces under If-Match and reports the new ETag', async () => {
    mockPutPolicy.mockResolvedValue({ etag: '"v2"' });

    await expect(
      orchestrator.putBucketPolicy(tenantId, 'photos', policy, { ifMatch: '"v1"' }),
    ).resolves.toStrictEqual({ etag: '"v2"' });
    expect(mockPutPolicy).toHaveBeenCalledWith(expect.any(Object), 'photos', policy, {
      ifMatch: '"v1"',
    });
  });

  it('creates under If-None-Match: *', async () => {
    mockPutPolicy.mockResolvedValue({ etag: '"v1"' });

    await expect(
      orchestrator.putBucketPolicy(tenantId, 'photos', policy, { ifNoneMatch: '*' }),
    ).resolves.toStrictEqual({ etag: '"v1"' });
    expect(mockPutPolicy).toHaveBeenCalledWith(expect.any(Object), 'photos', policy, {
      ifNoneMatch: '*',
    });
  });

  it('PolicyPrecondition rejects ifMatch and ifNoneMatch together', () => {
    // @ts-expect-error — a write carries If-Match or If-None-Match, never both.
    const _p: PolicyPrecondition = { ifMatch: '"e1"', ifNoneMatch: '*' };
    void _p;
  });

  it('does not retry when the If-Match precondition fails', async () => {
    mockPutPolicy.mockRejectedValue(new PolicyPreconditionFailedError('photos'));

    await expect(
      orchestrator.putBucketPolicy(tenantId, 'photos', policy, { ifMatch: '"old"' }),
    ).rejects.toBeInstanceOf(PolicyPreconditionFailedError);
    expect(mockPutPolicy).toHaveBeenCalledTimes(1);
  });

  it('retries a lock timeout and succeeds on the next attempt', async () => {
    mockPutPolicy
      .mockRejectedValueOnce(new PolicyConflictError())
      .mockResolvedValueOnce({ etag: '"v2"' });

    await expect(
      orchestrator.putBucketPolicy(tenantId, 'photos', policy, { ifMatch: '"v1"' }),
    ).resolves.toStrictEqual({ etag: '"v2"' });
    expect(mockPutPolicy).toHaveBeenCalledTimes(2);
  });

  it('retries a failed publish, then throws PolicyPublishError', async () => {
    mockPutPolicy.mockRejectedValue(new PolicyPublishError());

    await expect(
      orchestrator.putBucketPolicy(tenantId, 'photos', policy, { ifMatch: '"v1"' }),
    ).rejects.toBeInstanceOf(PolicyPublishError);
    expect(mockPutPolicy).toHaveBeenCalledTimes(3);
  });

  it('passes the storage system’s validation message through without retrying', async () => {
    mockPutPolicy.mockRejectedValue(new PolicyValidationError('unknown principal "bob"'));

    await expect(
      orchestrator.putBucketPolicy(tenantId, 'photos', policy, { ifMatch: '"v1"' }),
    ).rejects.toMatchObject({ name: 'PolicyValidationError', message: 'unknown principal "bob"' });
    expect(mockPutPolicy).toHaveBeenCalledTimes(1);
  });

  it('throws PolicyConflictError when the lock timeout persists through every retry', async () => {
    mockPutPolicy.mockRejectedValue(new PolicyConflictError());
    await expect(
      orchestrator.putBucketPolicy(tenantId, 'photos', policy, { ifMatch: '"v1"' }),
    ).rejects.toBeInstanceOf(PolicyConflictError);
    expect(mockPutPolicy).toHaveBeenCalledTimes(3);
  });
});

describe('deleteBucketPolicy', () => {
  it('passes the If-Match precondition to the S3 delete', async () => {
    mockDeletePolicy.mockResolvedValue(undefined);
    await expect(
      orchestrator.deleteBucketPolicy(tenantId, 'photos', { ifMatch: '"v1"' }),
    ).resolves.toBeUndefined();
    expect(mockDeletePolicy).toHaveBeenCalledWith(expect.any(Object), 'photos', {
      ifMatch: '"v1"',
    });
  });
});

describe('principals', () => {
  it.each([201, 200])('syncMember resolves when the principal PUT answers %i', async (status) => {
    mockPutPrincipal.mockResolvedValueOnce(ok({ principalId: 'alice' }, status));
    await expect(orchestrator.syncMember(tenantId, 'alice')).resolves.toBeUndefined();
    expect(mockPutPrincipal).toHaveBeenCalledWith(
      expect.objectContaining({ path: { tenantId, principalId: 'alice' } }),
    );
  });

  it('syncMember throws PolicyValidationError when the storage system answers 422', async () => {
    mockPutPrincipal.mockResolvedValue(fail(422, { message: 'invalid principal id' }));
    await expect(orchestrator.syncMember(tenantId, '*')).rejects.toBeInstanceOf(
      PolicyValidationError,
    );
  });

  it('removeMember resolves when the storage system answers 204', async () => {
    mockDeletePrincipal.mockResolvedValueOnce(buildSdkResult(204));
    await expect(orchestrator.removeMember(tenantId, 'alice')).resolves.toBeUndefined();
  });

  it('removeMember throws when the tenant is missing', async () => {
    mockDeletePrincipal.mockResolvedValueOnce(fail(404));
    await expect(orchestrator.removeMember(tenantId, 'alice')).rejects.toThrow(
      `Failed to remove principal "alice" for forge tenant ${tenantId}: the tenant does not exist`,
    );
  });

  it('listBucketPoliciesForMember returns each bucket with its policy', async () => {
    mockListPrincipalPolicies.mockResolvedValue(ok({ items: [{ bucketName: 'photos', policy }] }));

    await expect(
      orchestrator.listBucketPoliciesForMember(tenantId, 'alice'),
    ).resolves.toStrictEqual([{ bucketName: 'photos', policy }]);
  });

  it('resolveMemberAccess returns each bucket with the member’s actions', async () => {
    mockGetPrincipalAccess.mockResolvedValue(
      ok({ buckets: [{ name: 'photos', actions: ['s3:GetObject'] }] }),
    );

    await expect(orchestrator.resolveMemberAccess(tenantId, 'alice')).resolves.toStrictEqual([
      { bucketName: 'photos', actions: ['s3:GetObject'] },
    ]);
  });
});
