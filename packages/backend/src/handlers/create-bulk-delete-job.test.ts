import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  ApiErrorCode,
  BulkDeleteJobStatus,
  BulkDeleteScope,
  OrgRole,
  S3Region,
} from '@filone/shared';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import type { BulkDeleteJobRecord } from '../lib/dynamo-records.ts';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    BulkDeleteTable: { name: 'BulkDeleteTable' },
    BulkDeleteQueue: { url: 'https://sqs.example.com/bulk-delete.fifo' },
  },
}));

vi.mock('../middleware/auth.ts', async () =>
  (await import('../test/auth-partial-mock.ts')).authPartialMock(),
);
// Pass-through, so in the tests that run the whole chain the role gate is the
// only middleware that can refuse the request.
vi.mock('../middleware/csrf.ts', () => ({
  csrfMiddleware: () => ({ before: () => undefined }),
}));
vi.mock('../middleware/subscription-guard.ts', () => ({
  AccessLevel: { Read: 'read', Write: 'write' },
  subscriptionGuardMiddleware: () => ({ before: () => undefined }),
}));

vi.mock('../lib/bulk-delete-queue.ts', () => ({ enqueueBulkDeleteJob: vi.fn() }));

const mockIsTenantReady = vi.fn<() => string | undefined>(() => 'tenant-1');
const mockResolveMemberAccess = vi.fn();
vi.mock('../lib/service-orchestrator-registry.ts', () => ({
  getOrchestratorForRegion: (region: string) => ({
    region,
    isTenantReady: () => mockIsTenantReady(),
    resolveMemberAccess: (...args: unknown[]) => mockResolveMemberAccess(...args),
  }),
}));
vi.mock('../lib/org-profile.ts', () => ({ getOrgProfile: vi.fn(async () => ({})) }));

vi.mock('../lib/bulk-delete-jobs.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/bulk-delete-jobs.ts')>();
  return { ...actual, createBulkDeleteJob: vi.fn(), putBulkDeleteJob: vi.fn() };
});

process.env.FILONE_STAGE = 'test';

import {
  BulkDeleteJobExistsError,
  createBulkDeleteJob,
  putBulkDeleteJob,
} from '../lib/bulk-delete-jobs.ts';
import { enqueueBulkDeleteJob } from '../lib/bulk-delete-queue.ts';
import { baseHandler, handler } from './create-bulk-delete-job.ts';
import { buildContext, buildEvent, membershipFor } from '../test/lambda-test-utilities.ts';

const mockCreate = vi.mocked(createBulkDeleteJob);
const mockPutJob = vi.mocked(putBulkDeleteJob);
const mockEnqueue = vi.mocked(enqueueBulkDeleteJob);

const idempotencyKey = '3f1a6b2c-8d4e-4f0a-9b3c-1d2e3f4a5b6c';

function record(overrides: Partial<BulkDeleteJobRecord> = {}): BulkDeleteJobRecord {
  return {
    pk: 'BULKDELETE#org-1',
    sk: `JOB#${idempotencyKey}`,
    jobId: idempotencyKey,
    orgId: 'org-1',
    region: S3Region.EuWest1,
    bucketName: 'my-bucket',
    prefix: '',
    scope: BulkDeleteScope.AllVersions,
    status: BulkDeleteJobStatus.Pending,
    deletedCount: 0,
    failedCount: 0,
    failures: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ttl: 1,
    ...overrides,
  };
}

function event(
  body: unknown,
  bucketName: string | null = 'my-bucket',
  region: string = S3Region.EuWest1,
) {
  const built = buildEvent({
    method: 'POST',
    queryStringParameters: { region },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    userInfo: { orgId: 'org-1', userId: 'user-1' },
  });
  if (bucketName) built.pathParameters = { name: bucketName };
  return built;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsTenantReady.mockReturnValue('tenant-1');
  mockCreate.mockResolvedValue(record());
});

describe('create-bulk-delete-job', () => {
  it('creates a job and queues it for the worker', async () => {
    const result = await baseHandler(event({ idempotencyKey }));

    expect(result.statusCode).toBe(202);
    expect(JSON.parse(result.body!).job.jobId).toBe(idempotencyKey);
    expect(mockEnqueue).toHaveBeenCalledWith({ orgId: 'org-1', jobId: idempotencyKey }, 0);
  });

  it('fails the job when it cannot be queued', async () => {
    mockEnqueue.mockRejectedValueOnce(new Error('sqs unavailable'));

    // The row is already written, so leaving it pending would give the UI a job
    // to poll that nothing is ever going to pick up.
    await expect(baseHandler(event({ idempotencyKey }))).rejects.toThrow('sqs unavailable');
    expect(mockPutJob.mock.calls[0][0].status).toBe(BulkDeleteJobStatus.Failed);
  });

  it('passes the idempotency key through so the job id can be derived from it', async () => {
    await baseHandler(event({ idempotencyKey }));
    expect(mockCreate.mock.calls[0][0].idempotencyKey).toBe(idempotencyKey);
  });

  it('defaults to the whole bucket and all versions', async () => {
    await baseHandler(event({ idempotencyKey }));
    const args = mockCreate.mock.calls[0][0];
    expect(args.prefix).toBe('');
    expect(args.scope).toBe(BulkDeleteScope.AllVersions);
  });

  it('passes an explicit prefix and scope through', async () => {
    await baseHandler(event({ idempotencyKey, prefix: 'photos/', scope: BulkDeleteScope.Current }));
    const args = mockCreate.mock.calls[0][0];
    expect(args.prefix).toBe('photos/');
    expect(args.scope).toBe(BulkDeleteScope.Current);
  });

  it('returns the running job for a duplicate submit without starting another', async () => {
    const existing = record({ status: BulkDeleteJobStatus.Running, deletedCount: 40 });
    mockCreate.mockRejectedValue(new BulkDeleteJobExistsError(existing));

    const result = await baseHandler(event({ idempotencyKey }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!).job.deletedCount).toBe(40);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('rejects a request with no idempotency key', async () => {
    const result = await baseHandler(event({}));
    expect(result.statusCode).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects a malformed body', async () => {
    const result = await baseHandler(event('not json'));
    expect(result.statusCode).toBe(400);
  });

  it('requires a bucket name', async () => {
    const result = await baseHandler(event({ idempotencyKey }, null));
    expect(result.statusCode).toBe(400);
  });

  it('rejects an unsupported region', async () => {
    const result = await baseHandler(event({ idempotencyKey }, 'my-bucket', 'mars-1'));
    expect(result.statusCode).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses when the tenant is not provisioned', async () => {
    mockIsTenantReady.mockReturnValue(undefined);
    const result = await baseHandler(event({ idempotencyKey }));
    expect(result.statusCode).toBe(503);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // FIL-1548. A bulk delete runs in the worker with the tenant's key, which the
  // storage system never evaluates a policy for, so a scoped member's bucket
  // policies are only enforced if this route checks them, as presign does.
  describe('member scope on an iam region', () => {
    const iamRegion = S3Region.UsEast9;
    const grantActionsOnBucket = (bucketName: string, actions: string[]) => [
      { bucketName, actions },
    ];

    function eventAs(role: OrgRole, body: unknown = { idempotencyKey }) {
      const built = buildEvent({
        method: 'POST',
        queryStringParameters: { region: iamRegion },
        body: JSON.stringify(body),
        userInfo: {
          orgId: 'org-1',
          userId: 'any-user',
          membership: membershipFor('org-1', 'any-user', role),
        },
      });
      built.pathParameters = { name: 'my-bucket' };
      return built;
    }

    it('refuses with the missing-bucket 404 a Member whose policies leave the bucket out', async () => {
      mockResolveMemberAccess.mockResolvedValue(
        grantActionsOnBucket('other-bucket', [
          's3:ListBucket',
          's3:ListBucketVersions',
          's3:DeleteObject',
          's3:DeleteObjectVersion',
        ]),
      );

      const result = await baseHandler(eventAs(OrgRole.Member));

      expect({ statusCode: result.statusCode, body: JSON.parse(result.body!) }).toStrictEqual({
        statusCode: 404,
        body: { message: 'Bucket not found' },
      });
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('refuses a Member whose policy grants the bucket but no delete', async () => {
      mockResolveMemberAccess.mockResolvedValue(
        grantActionsOnBucket('my-bucket', ['s3:ListBucket', 's3:GetObject']),
      );

      const result = await baseHandler(
        eventAs(OrgRole.Member, { idempotencyKey, scope: BulkDeleteScope.Current }),
      );

      expect({ statusCode: result.statusCode, body: JSON.parse(result.body!) }).toStrictEqual({
        statusCode: 403,
        body: { message: 'Your access to my-bucket does not permit bulk deletion.' },
      });
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('refuses an all-versions delete for a Member whose policy lacks s3:DeleteObjectVersion', async () => {
      mockResolveMemberAccess.mockResolvedValue(
        grantActionsOnBucket('my-bucket', [
          's3:ListBucket',
          's3:ListBucketVersions',
          's3:DeleteObject',
        ]),
      );

      const result = await baseHandler(
        eventAs(OrgRole.Member, { idempotencyKey, scope: BulkDeleteScope.AllVersions }),
      );

      expect({ statusCode: result.statusCode, body: JSON.parse(result.body!) }).toStrictEqual({
        statusCode: 403,
        body: { message: 'Your access to my-bucket does not permit bulk deletion.' },
      });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("looks up the Member's access by tenant and user id", async () => {
      mockResolveMemberAccess.mockResolvedValue([]);

      await baseHandler(eventAs(OrgRole.Member));

      expect(mockResolveMemberAccess).toHaveBeenCalledWith('tenant-1', 'any-user');
    });

    it('queues the job for a Member whose policy grants every action an all-versions delete needs', async () => {
      mockResolveMemberAccess.mockResolvedValue(
        grantActionsOnBucket('my-bucket', [
          's3:ListBucket',
          's3:ListBucketVersions',
          's3:DeleteObject',
          's3:DeleteObjectVersion',
        ]),
      );

      const result = await baseHandler(eventAs(OrgRole.Member));

      expect(result.statusCode).toBe(202);
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
    });

    it('queues a current-versions delete for a Member whose policy grants s3:ListBucket and s3:DeleteObject', async () => {
      mockResolveMemberAccess.mockResolvedValue(
        grantActionsOnBucket('my-bucket', ['s3:ListBucket', 's3:DeleteObject']),
      );

      const result = await baseHandler(
        eventAs(OrgRole.Member, { idempotencyKey, scope: BulkDeleteScope.Current }),
      );

      expect(result.statusCode).toBe(202);
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
    });

    it('queues the job without an access lookup for a Member on a service-keys region', async () => {
      const built = eventAs(OrgRole.Member);
      built.queryStringParameters = { region: S3Region.EuWest1 };

      const result = await baseHandler(built);

      expect(result.statusCode).toBe(202);
      expect(mockResolveMemberAccess).not.toHaveBeenCalled();
    });

    it.each([OrgRole.Owner, OrgRole.Admin])(
      'queues the job without an access lookup for an %s',
      async (role) => {
        const result = await baseHandler(eventAs(role));

        expect(result.statusCode).toBe(202);
        expect(mockResolveMemberAccess).not.toHaveBeenCalled();
      },
    );
  });

  // These run the exported Middy chain rather than baseHandler, since the role
  // check is the chain's `authorize('objects.delete')`.
  describe('a ReadOnly caller', () => {
    beforeEach(() => {
      // authorize logs the denial and writes an EMF metric to stdout.
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    async function invokeAsReadOnly(region: S3Region) {
      const built = buildEvent({
        method: 'POST',
        queryStringParameters: { region },
        body: JSON.stringify({ idempotencyKey }),
        userInfo: {
          orgId: 'org-1',
          userId: 'any-user',
          membership: membershipFor('org-1', 'any-user', OrgRole.ReadOnly),
        },
      });
      built.pathParameters = { name: 'my-bucket' };
      // Every refusal here is a ResponseBuilder result, never the string arm
      // middy's declared return type carries.
      return (await handler(built, buildContext())) as APIGatewayProxyStructuredResultV2;
    }

    it.each([S3Region.EuWest1, S3Region.UsEast9])(
      'is refused for its role on %s',
      async (region) => {
        const result = await invokeAsReadOnly(region);

        expect({ statusCode: result.statusCode, body: JSON.parse(result.body!) }).toMatchObject({
          statusCode: 403,
          body: { code: ApiErrorCode.FORBIDDEN_ROLE },
        });
      },
    );

    it.each([S3Region.EuWest1, S3Region.UsEast9])(
      'creates and queues no job on %s',
      async (region) => {
        await invokeAsReadOnly(region);

        expect(mockCreate).not.toHaveBeenCalled();
        expect(mockEnqueue).not.toHaveBeenCalled();
      },
    );

    it('is refused even when a bucket policy grants it every delete action', async () => {
      // The role gate is the console's, and no bucket policy widens it.
      mockResolveMemberAccess.mockResolvedValue([
        {
          bucketName: 'my-bucket',
          actions: [
            's3:ListBucket',
            's3:ListBucketVersions',
            's3:DeleteObject',
            's3:DeleteObjectVersion',
          ],
        },
      ]);

      const result = await invokeAsReadOnly(S3Region.UsEast9);

      expect(result.statusCode).toBe(403);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });
});
