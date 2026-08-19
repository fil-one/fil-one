import { describe, it, expect, vi, beforeEach } from 'vitest';

import { BulkDeleteJobStatus, BulkDeleteScope, S3Region } from '@filone/shared';

import type { BulkDeleteJobRecord } from '../lib/dynamo-records.js';

vi.mock('sst', () => ({
  Resource: {
    BulkDeleteTable: { name: 'BulkDeleteTable' },
    BulkDeleteQueue: { url: 'https://sqs.example.com/bulk-delete.fifo' },
  },
}));

vi.mock('../lib/bulk-delete-jobs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/bulk-delete-jobs.js')>();
  return {
    ...actual,
    getBulkDeleteJob: vi.fn(),
    putBulkDeleteJob: vi.fn(),
  };
});
vi.mock('../lib/s3-bulk-delete.js', () => ({
  enumerateDeletionPage: vi.fn(),
  deleteTargets: vi.fn(),
}));
vi.mock('../lib/s3-bucket-operations.js', () => ({
  getBucketVersioningStatus: vi.fn(async () => 'Enabled'),
}));
vi.mock('../lib/s3-client.js', () => ({ createS3Client: vi.fn(() => ({})) }));
vi.mock('../lib/org-profile.js', () => ({ getOrgProfile: vi.fn(async () => ({})) }));
vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getOrchestratorForRegion: vi.fn(() => ({
    isTenantReady: () => 'tenant-1',
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

vi.mock('../lib/bulk-delete-queue.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/bulk-delete-queue.js')>();
  return { ...actual, enqueueBulkDeleteJob: vi.fn() };
});

import { getBulkDeleteJob, putBulkDeleteJob } from '../lib/bulk-delete-jobs.js';
import { enqueueBulkDeleteJob } from '../lib/bulk-delete-queue.js';
import { deleteTargets, enumerateDeletionPage } from '../lib/s3-bulk-delete.js';
import { processJob } from './bulk-delete-worker.js';

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
    const registry = await import('../lib/service-orchestrator-registry.js');
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
});
