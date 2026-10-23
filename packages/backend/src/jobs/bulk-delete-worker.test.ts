import { describe, it, expect, vi, beforeEach } from 'vitest';

import { BulkDeleteJobStatus, BulkDeleteScope, OrgRole, S3Region } from '@filone/shared';

import type { BulkDeleteJobRecord } from '../lib/dynamo-records.ts';

vi.mock('sst', () => ({
  Resource: {
    BulkDeleteTable: { name: 'BulkDeleteTable' },
    BulkDeleteQueue: { url: 'https://sqs.example.com/bulk-delete.fifo' },
  },
}));

vi.mock('../lib/bulk-delete-jobs.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/bulk-delete-jobs.ts')>();
  return {
    ...actual,
    getBulkDeleteJob: vi.fn(),
    putBulkDeleteJob: vi.fn(),
  };
});
vi.mock('../lib/s3-bulk-delete.ts', () => ({
  enumerateDeletionPage: vi.fn(),
  deleteTargets: vi.fn(),
}));
vi.mock('../lib/s3-bucket-operations.ts', () => ({
  getBucketVersioningStatus: vi.fn(async () => 'Enabled'),
}));
vi.mock('../lib/s3-client.ts', () => ({ createS3Client: vi.fn(() => ({})) }));
vi.mock('../lib/org-profile.ts', () => ({ getOrgProfile: vi.fn(async () => ({})) }));
const mockResolveMemberAccess = vi.fn();
const mockResolveMembership = vi.fn();
vi.mock('../lib/org-membership.ts', () => ({
  resolveMembership: (...args: unknown[]) => mockResolveMembership(...args),
}));
vi.mock('../lib/service-orchestrator-registry.ts', () => ({
  getOrchestratorForRegion: vi.fn((region: string) => ({
    region,
    isTenantReady: () => 'tenant-1',
    resolveMemberAccess: (...args: unknown[]) => mockResolveMemberAccess(...args),
    getS3ClientContext: async () => ({
      endpointUrl: 'https://s3.example.com',
      region: 'auto',
      credentials: { accessKeyId: 'ak', secretAccessKey: 'sk' },
      forcePathStyle: true,
      orchestratorId: 'test',
      tenantId: 'tenant-1',
    }),
  })),
}));

vi.mock('../lib/bulk-delete-queue.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/bulk-delete-queue.ts')>();
  return { ...actual, enqueueBulkDeleteJob: vi.fn() };
});

import { getBulkDeleteJob, putBulkDeleteJob } from '../lib/bulk-delete-jobs.ts';
import { enqueueBulkDeleteJob } from '../lib/bulk-delete-queue.ts';
import { getBucketVersioningStatus } from '../lib/s3-bucket-operations.ts';
import { deleteTargets, enumerateDeletionPage } from '../lib/s3-bulk-delete.ts';
import { processJob } from './bulk-delete-worker.ts';

const mockGetJob = vi.mocked(getBulkDeleteJob);
const mockPutJob = vi.mocked(putBulkDeleteJob);
const mockEnumerate = vi.mocked(enumerateDeletionPage);
const mockDelete = vi.mocked(deleteTargets);
const mockEnqueue = vi.mocked(enqueueBulkDeleteJob);

function job(overrides: Partial<BulkDeleteJobRecord> = {}): BulkDeleteJobRecord {
  return {
    pk: 'BULKDELETE#org-1',
    sk: 'JOB#job-1',
    jobId: 'job-1',
    orgId: 'org-1',
    region: S3Region.EuWest1,
    bucketName: 'bucket',
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

const payload = { orgId: 'org-1', jobId: 'job-1' };

/** First delivery of the message: the queue still has redeliveries left. */
const FIRST_DELIVERY = 1;
/** Receive count at which SQS redrives to the dead-letter queue next. */
const LAST_DELIVERY = 3;

/** Plenty of budget: the worker drains every page in one invocation. */
const generousBudget = () => 900_000;

/** Persisted job state from the last write, which is what the UI would see. */
function lastSavedJob(): BulkDeleteJobRecord {
  const calls = mockPutJob.mock.calls;
  return calls[calls.length - 1][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDelete.mockResolvedValue({ deleted: 0, failures: [] });
});

describe('bulk-delete worker', () => {
  it('does nothing when the job is missing', async () => {
    mockGetJob.mockResolvedValue(undefined);
    await processJob(payload, FIRST_DELIVERY, generousBudget);
    expect(mockPutJob).not.toHaveBeenCalled();
  });

  it('skips a job that already finished', async () => {
    mockGetJob.mockResolvedValue(job({ status: BulkDeleteJobStatus.Completed }));
    await processJob(payload, FIRST_DELIVERY, generousBudget);
    expect(mockEnumerate).not.toHaveBeenCalled();
    expect(mockPutJob).not.toHaveBeenCalled();
  });

  it('skips a job already in the completed-with-errors terminal state', async () => {
    // finalizeJob clears the cursor for this status too, so a duplicate
    // delivery must not restart the listing walk from the beginning.
    mockGetJob.mockResolvedValue(job({ status: BulkDeleteJobStatus.CompletedWithErrors }));
    await processJob(payload, FIRST_DELIVERY, generousBudget);
    expect(mockEnumerate).not.toHaveBeenCalled();
    expect(mockPutJob).not.toHaveBeenCalled();
  });

  it('walks every page and completes in one invocation', async () => {
    mockGetJob.mockResolvedValue(job());
    mockEnumerate
      .mockResolvedValueOnce({
        targets: [{ key: 'a.txt' }],
        nextCursor: { keyMarker: 'a.txt' },
      })
      .mockResolvedValueOnce({ targets: [{ key: 'b.txt' }] });
    mockDelete.mockResolvedValue({ deleted: 1, failures: [] });

    await processJob(payload, FIRST_DELIVERY, generousBudget);

    expect(mockEnumerate).toHaveBeenCalledTimes(2);
    const saved = lastSavedJob();
    expect(saved.status).toBe(BulkDeleteJobStatus.Completed);
    expect(saved.deletedCount).toBe(2);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('resumes from the persisted cursor', async () => {
    mockGetJob.mockResolvedValue(job({ cursor: { keyMarker: 'resume-here' } }));
    mockEnumerate.mockResolvedValue({ targets: [] });

    await processJob(payload, FIRST_DELIVERY, generousBudget);

    expect(mockEnumerate.mock.calls[0][0].cursor).toEqual({ keyMarker: 'resume-here' });
  });

  it('checkpoints and queues a continuation when the time budget runs out', async () => {
    mockGetJob.mockResolvedValue(job());
    mockEnumerate.mockResolvedValue({
      targets: [{ key: 'a.txt' }],
      nextCursor: { keyMarker: 'a.txt' },
    });
    // No usable budget: take one page, checkpoint, hand off.
    await processJob(payload, FIRST_DELIVERY, () => 0);

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const saved = lastSavedJob();
    expect(saved.status).toBe(BulkDeleteJobStatus.Running);
    expect(saved.cursor).toEqual({ keyMarker: 'a.txt' });
  });

  it('marks a job completed with errors when objects could not be deleted', async () => {
    mockGetJob.mockResolvedValue(job());
    mockEnumerate.mockResolvedValue({ targets: [{ key: 'locked.txt' }] });
    mockDelete.mockResolvedValue({
      deleted: 0,
      failures: [{ key: 'locked.txt', code: 'AccessDenied', message: 'under retention' }],
    });

    await processJob(payload, FIRST_DELIVERY, generousBudget);

    const saved = lastSavedJob();
    expect(saved.status).toBe(BulkDeleteJobStatus.CompletedWithErrors);
    expect(saved.failedCount).toBe(1);
  });

  it('advances the resume count before handing off, and uses it as the message id', async () => {
    mockGetJob.mockResolvedValue(job({ resumeCount: 2 }));
    mockEnumerate.mockResolvedValue({
      targets: [{ key: 'a.txt' }],
      nextCursor: { keyMarker: 'a.txt' },
    });

    await processJob(payload, FIRST_DELIVERY, () => 0);

    // Persisted first: a crash before the send must not let a redelivery reuse
    // a deduplication id SQS has already seen.
    expect(lastSavedJob().resumeCount).toBe(3);
    expect(mockEnqueue).toHaveBeenCalledWith(payload, 3);
    expect(mockPutJob.mock.invocationCallOrder[mockPutJob.mock.calls.length - 1]).toBeLessThan(
      mockEnqueue.mock.invocationCallOrder[0],
    );
  });

  it('rethrows without failing the job when deliveries remain', async () => {
    mockGetJob.mockResolvedValue(job());
    mockEnumerate.mockRejectedValue(new Error('listing blew up'));

    // The error escaping is what returns the message to the queue. Recording a
    // failed job here instead would turn a transient fault into a dead job.
    await expect(processJob(payload, FIRST_DELIVERY, generousBudget)).rejects.toThrow(
      'listing blew up',
    );
    expect(mockPutJob).not.toHaveBeenCalled();
  });

  it('records the failure on the last delivery, then rethrows for the dead-letter queue', async () => {
    mockGetJob.mockResolvedValue(job());
    mockEnumerate.mockRejectedValue(new Error('listing blew up'));

    await expect(processJob(payload, LAST_DELIVERY, generousBudget)).rejects.toThrow(
      'listing blew up',
    );

    const saved = lastSavedJob();
    expect(saved.status).toBe(BulkDeleteJobStatus.Failed);
    expect(saved.error).toBe('listing blew up');
  });

  it('preserves progress from completed pages when a later page throws', async () => {
    mockGetJob.mockResolvedValue(job());
    mockEnumerate
      .mockResolvedValueOnce({ targets: [{ key: 'a.txt' }], nextCursor: { keyMarker: 'a.txt' } })
      .mockRejectedValueOnce(new Error('listing blew up on page 2'));
    mockDelete.mockResolvedValueOnce({ deleted: 1, failures: [] });

    await expect(processJob(payload, LAST_DELIVERY, generousBudget)).rejects.toThrow();

    const saved = lastSavedJob();
    expect(saved.status).toBe(BulkDeleteJobStatus.Failed);
    // The first page's deletion must not be lost by failing on the stale
    // start-of-invocation record.
    expect(saved.deletedCount).toBe(1);
  });

  it('fails a non-retryable error on the first delivery without redelivering', async () => {
    const registry = await import('../lib/service-orchestrator-registry.ts');
    vi.mocked(registry.getOrchestratorForRegion).mockReturnValueOnce({
      isTenantReady: () => undefined,
    } as never);
    mockGetJob.mockResolvedValue(job());

    // Provisioning will not appear between deliveries, so spending the retries
    // on it would only delay the failure the user is waiting to see.
    await expect(processJob(payload, FIRST_DELIVERY, generousBudget)).resolves.toBeUndefined();

    const saved = lastSavedJob();
    expect(saved.status).toBe(BulkDeleteJobStatus.Failed);
    expect(saved.error).toContain('not provisioned');
  });

  // The worker deletes with the tenant's key, so the starter's role and, for a
  // scoped member, their bucket access are re-checked before each run: a change
  // made after the job was queued applies to its next run.
  describe('a job a member started, on an iam region', () => {
    const memberJob = (overrides: Partial<BulkDeleteJobRecord> = {}) =>
      job({ region: S3Region.UsEast9, startedBy: 'any-member', ...overrides });
    const allVersionsActions = [
      's3:ListBucketVersions',
      's3:DeleteObject',
      's3:DeleteObjectVersion',
    ];

    beforeEach(() => {
      mockEnumerate.mockResolvedValue({ targets: [{ key: 'a.txt' }] });
      mockResolveMembership.mockResolvedValue({ role: OrgRole.Member });
    });

    it('deletes when the member still holds every action the scope needs', async () => {
      mockGetJob.mockResolvedValue(memberJob());
      mockResolveMemberAccess.mockResolvedValue([
        { bucketName: 'bucket', actions: allVersionsActions },
      ]);

      await processJob(payload, FIRST_DELIVERY, generousBudget);

      expect(mockDelete).toHaveBeenCalledTimes(1);
      expect(lastSavedJob().status).toBe(BulkDeleteJobStatus.Completed);
    });

    it('deletes for a member without s3:DeleteObjectVersion on a bucket that never enabled versioning', async () => {
      // The worker drops the "null" version id there and issues plain deletes.
      vi.mocked(getBucketVersioningStatus).mockResolvedValueOnce('Never');
      mockGetJob.mockResolvedValue(memberJob());
      mockResolveMemberAccess.mockResolvedValue([
        { bucketName: 'bucket', actions: ['s3:ListBucketVersions', 's3:DeleteObject'] },
      ]);

      await processJob(payload, FIRST_DELIVERY, generousBudget);

      expect(mockDelete).toHaveBeenCalledTimes(1);
      expect(lastSavedJob().status).toBe(BulkDeleteJobStatus.Completed);
    });

    it("reads the bucket's versioning once a run, though access is checked before every page", async () => {
      mockGetJob.mockResolvedValue(memberJob());
      mockResolveMemberAccess.mockResolvedValue([
        { bucketName: 'bucket', actions: allVersionsActions },
      ]);
      mockEnumerate
        .mockResolvedValueOnce({ targets: [{ key: 'a.txt' }], nextCursor: { keyMarker: 'a.txt' } })
        .mockResolvedValueOnce({ targets: [{ key: 'b.txt' }] });

      await processJob(payload, FIRST_DELIVERY, generousBudget);

      expect(mockResolveMemberAccess).toHaveBeenCalledTimes(2);
      expect(getBucketVersioningStatus).toHaveBeenCalledTimes(1);
    });

    // Revoked mid-run, after the first page: the check before the second page
    // stops the job, and the first page's progress is kept.
    it.each([
      {
        revocation: 'the starter is demoted to ReadOnly',
        revoke: () =>
          mockResolveMembership
            .mockResolvedValueOnce({ role: OrgRole.Member })
            .mockResolvedValueOnce({ role: OrgRole.ReadOnly }),
        error: 'Your role no longer permits deleting objects',
      },
      {
        revocation: "the bucket's policy stops granting the starter",
        revoke: () =>
          mockResolveMemberAccess
            .mockResolvedValueOnce([{ bucketName: 'bucket', actions: allVersionsActions }])
            .mockResolvedValueOnce([]),
        error: 'Your access to bucket no longer permits bulk deletion',
      },
    ])(
      'stops before the next page when $revocation between two pages',
      async ({ revoke, error }) => {
        mockGetJob.mockResolvedValue(memberJob());
        mockResolveMemberAccess.mockResolvedValue([
          { bucketName: 'bucket', actions: allVersionsActions },
        ]);
        revoke();
        mockEnumerate.mockResolvedValueOnce({
          targets: [{ key: 'a.txt' }],
          nextCursor: { keyMarker: 'a.txt' },
        });
        mockDelete.mockResolvedValue({ deleted: 1, failures: [] });

        await processJob(payload, FIRST_DELIVERY, generousBudget);

        expect(mockEnumerate).toHaveBeenCalledTimes(1);
        expect(mockDelete).toHaveBeenCalledTimes(1);
        expect(lastSavedJob()).toMatchObject({
          status: BulkDeleteJobStatus.Failed,
          deletedCount: 1,
          error,
        });
      },
    );

    it.each([
      // A role change leaves bucket policies alone, so the policy still grants.
      ['has since been demoted to ReadOnly', { role: OrgRole.ReadOnly }],
      ['is no longer a member', undefined],
    ])('fails the job without deleting when the starter %s', async (_case, membership) => {
      mockResolveMembership.mockResolvedValue(membership);
      mockGetJob.mockResolvedValue(memberJob());
      mockResolveMemberAccess.mockResolvedValue([
        { bucketName: 'bucket', actions: allVersionsActions },
      ]);

      // A role change will not be undone by redelivery.
      await expect(processJob(payload, FIRST_DELIVERY, generousBudget)).resolves.toBeUndefined();

      expect(mockDelete).not.toHaveBeenCalled();
      expect(lastSavedJob()).toMatchObject({
        status: BulkDeleteJobStatus.Failed,
        error: 'Your role no longer permits deleting objects',
      });
    });

    it("reads the starter's membership in the job's org", async () => {
      mockGetJob.mockResolvedValue(memberJob());
      mockResolveMemberAccess.mockResolvedValue([
        { bucketName: 'bucket', actions: allVersionsActions },
      ]);

      await processJob(payload, FIRST_DELIVERY, generousBudget);

      expect(mockResolveMembership).toHaveBeenCalledWith('org-1', 'any-member');
    });

    it('deletes without a policy check for a starter since promoted to Admin', async () => {
      mockResolveMembership.mockResolvedValue({ role: OrgRole.Admin });
      mockGetJob.mockResolvedValue(memberJob());
      mockResolveMemberAccess.mockResolvedValue([]);

      await processJob(payload, FIRST_DELIVERY, generousBudget);

      expect(mockResolveMemberAccess).not.toHaveBeenCalled();
      expect(mockDelete).toHaveBeenCalledTimes(1);
    });

    it("looks up the member's access by tenant and member id", async () => {
      mockGetJob.mockResolvedValue(memberJob());
      mockResolveMemberAccess.mockResolvedValue([
        { bucketName: 'bucket', actions: allVersionsActions },
      ]);

      await processJob(payload, FIRST_DELIVERY, generousBudget);

      expect(mockResolveMemberAccess).toHaveBeenCalledWith('tenant-1', 'any-member');
    });

    it.each([
      [
        'no policy grants the member the bucket any longer',
        [] as { bucketName: string; actions: string[] }[],
      ],
      [
        "the bucket's policy no longer grants s3:DeleteObjectVersion",
        [{ bucketName: 'bucket', actions: ['s3:ListBucketVersions', 's3:DeleteObject'] }],
      ],
    ])('fails the job without listing or deleting when %s', async (_case, access) => {
      mockGetJob.mockResolvedValue(memberJob());
      mockResolveMemberAccess.mockResolvedValue(access);

      // A policy change will not be undone by redelivery, so the first delivery
      // fails the job rather than spending the retries.
      await expect(processJob(payload, FIRST_DELIVERY, generousBudget)).resolves.toBeUndefined();

      expect(mockEnumerate).not.toHaveBeenCalled();
      expect(mockDelete).not.toHaveBeenCalled();
      expect(lastSavedJob()).toMatchObject({
        status: BulkDeleteJobStatus.Failed,
        error: 'Your access to bucket no longer permits bulk deletion',
      });
    });

    it('re-checks access on a continuation, not only on the first run', async () => {
      // A job resumed from a checkpoint after the member lost the bucket.
      mockGetJob.mockResolvedValue(memberJob({ resumeCount: 2, cursor: { keyMarker: 'a.txt' } }));
      mockResolveMemberAccess.mockResolvedValue([]);

      await processJob(payload, FIRST_DELIVERY, generousBudget);

      expect(mockDelete).not.toHaveBeenCalled();
      expect(lastSavedJob().status).toBe(BulkDeleteJobStatus.Failed);
    });

    it('leaves a failed access lookup to redelivery', async () => {
      mockGetJob.mockResolvedValue(memberJob());
      mockResolveMemberAccess.mockRejectedValue(new Error('management api unavailable'));

      await expect(processJob(payload, FIRST_DELIVERY, generousBudget)).rejects.toThrow(
        'management api unavailable',
      );
      expect(mockDelete).not.toHaveBeenCalled();
      expect(mockPutJob).not.toHaveBeenCalled();
    });

    it('runs a job queued before its starter was recorded without either lookup', async () => {
      mockGetJob.mockResolvedValue(memberJob({ startedBy: undefined }));

      await processJob(payload, FIRST_DELIVERY, generousBudget);

      expect(mockResolveMembership).not.toHaveBeenCalled();
      expect(mockResolveMemberAccess).not.toHaveBeenCalled();
      expect(mockDelete).toHaveBeenCalledTimes(1);
    });

    it('skips the lookup on a service-keys region', async () => {
      mockGetJob.mockResolvedValue(memberJob({ region: S3Region.EuWest1 }));

      await processJob(payload, FIRST_DELIVERY, generousBudget);

      expect(mockResolveMemberAccess).not.toHaveBeenCalled();
      expect(mockDelete).toHaveBeenCalledTimes(1);
    });
  });
});
