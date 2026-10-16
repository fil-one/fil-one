import { describe, it, expect, vi, beforeEach } from 'vitest';
import { S3Region } from '@filone/shared';
import { policyOf, statement } from '../../test/policy-statements.ts';

vi.mock('sst', () => ({ Resource: { UserInfoTable: { name: 'UserInfoTable' } } }));

// The policy operations go over S3 and are mocked at the S3 operations module;
// the console credential lookup behind them is stubbed so no client reaches SSM.
const mockGetPolicy = vi.fn((..._a: unknown[]): unknown => null);
const mockPutPolicy = vi.fn((..._a: unknown[]): unknown => ({}));
const mockDeletePolicy = vi.fn((..._a: unknown[]): unknown => undefined);

vi.mock('@filone/orchestrator-client', () => ({ createClient: () => 'mock-client' }));
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

const ALICE = '00000000-0000-0000-0000-00000000000a';
const BOB = '00000000-0000-0000-0000-00000000000b';

const tenantId = '00000000-0000-0000-0000-000000000001';
const policy = policyOf(statement('photos', 'Allow', [ALICE], ['s3:GetObject']));

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
    mockPutPolicy.mockRejectedValue(new PolicyValidationError(`unknown principal "${BOB}"`));

    await expect(
      orchestrator.putBucketPolicy(tenantId, 'photos', policy, { ifMatch: '"v1"' }),
    ).rejects.toMatchObject({
      name: 'PolicyValidationError',
      message: `unknown principal "${BOB}"`,
    });
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
