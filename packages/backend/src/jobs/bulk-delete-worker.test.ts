import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'aws-lambda';

import { BulkDeleteJobStatus, BulkDeleteScope, S3Region } from '@filone/shared';

import type { BulkDeleteJobRecord } from '../lib/dynamo-records.js';

vi.mock('sst', () => ({
  Resource: {
    BulkDeleteTable: { name: 'BulkDeleteTable' },
    BulkDeleteWorker: { name: 'BulkDeleteWorker' },
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

// Hoisted so the mock factory (itself hoisted above the module body) can close
// over it.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = sendMock;
  },
  InvokeCommand: class {
    constructor(public input: unknown) {}
  },
}));

import { getBulkDeleteJob, putBulkDeleteJob } from '../lib/bulk-delete-jobs.js';
import { deleteTargets, enumerateDeletionPage } from '../lib/s3-bulk-delete.js';
import { handler } from './bulk-delete-worker.js';

const mockGetJob = vi.mocked(getBulkDeleteJob);
const mockPutJob = vi.mocked(putBulkDeleteJob);
const mockEnumerate = vi.mocked(enumerateDeletionPage);
const mockDelete = vi.mocked(deleteTargets);

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
    multiDelete: true,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ttl: 1,
    ...overrides,
  };
}

const context = {} as Context;
const payload = { orgId: 'org-1', jobId: 'job-1' };

/** Plenty of budget: the worker drains every page in one invocation. */
const generousBudget = () => 900_000;

/** Persisted job state from the last write, which is what the UI would see. */
function lastSavedJob(): BulkDeleteJobRecord {
  const calls = mockPutJob.mock.calls;
  return calls[calls.length - 1][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDelete.mockResolvedValue({ deleted: 0, failures: [], multiDeleteUnsupported: false });
});

describe('bulk-delete worker', () => {
  it('does nothing when the job is missing', async () => {
    mockGetJob.mockResolvedValue(undefined);
    await handler(payload, context, generousBudget);
    expect(mockPutJob).not.toHaveBeenCalled();
  });

  it('skips a job that already finished', async () => {
    mockGetJob.mockResolvedValue(job({ status: BulkDeleteJobStatus.Completed }));
    await handler(payload, context, generousBudget);
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
    mockDelete.mockResolvedValue({ deleted: 1, failures: [], multiDeleteUnsupported: false });

    await handler(payload, context, generousBudget);

    expect(mockEnumerate).toHaveBeenCalledTimes(2);
    const saved = lastSavedJob();
    expect(saved.status).toBe(BulkDeleteJobStatus.Completed);
    expect(saved.deletedCount).toBe(2);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('resumes from the persisted cursor', async () => {
    mockGetJob.mockResolvedValue(job({ cursor: { keyMarker: 'resume-here' } }));
    mockEnumerate.mockResolvedValue({ targets: [] });

    await handler(payload, context, generousBudget);

    expect(mockEnumerate.mock.calls[0][0].cursor).toEqual({ keyMarker: 'resume-here' });
  });

  it('checkpoints and re-invokes itself when the time budget runs out', async () => {
    mockGetJob.mockResolvedValue(job());
    mockEnumerate.mockResolvedValue({
      targets: [{ key: 'a.txt' }],
      nextCursor: { keyMarker: 'a.txt' },
    });
    // No usable budget: take one page, checkpoint, hand off.
    await handler(payload, context, () => 0);

    expect(sendMock).toHaveBeenCalledTimes(1);
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
      multiDeleteUnsupported: false,
    });

    await handler(payload, context, generousBudget);

    const saved = lastSavedJob();
    expect(saved.status).toBe(BulkDeleteJobStatus.CompletedWithErrors);
    expect(saved.failedCount).toBe(1);
  });

  it('stops attempting batched deletes once the gateway rejects them', async () => {
    mockGetJob.mockResolvedValue(job());
    mockEnumerate
      .mockResolvedValueOnce({ targets: [{ key: 'a.txt' }], nextCursor: { keyMarker: 'a.txt' } })
      .mockResolvedValueOnce({ targets: [{ key: 'b.txt' }] });
    mockDelete
      .mockResolvedValueOnce({ deleted: 1, failures: [], multiDeleteUnsupported: true })
      .mockResolvedValueOnce({ deleted: 1, failures: [], multiDeleteUnsupported: false });

    await handler(payload, context, generousBudget);

    // Second page must not re-probe the unsupported batch API.
    expect(mockDelete.mock.calls[1][0].multiDelete).toBe(false);
  });

  it('records a failure status when the run throws', async () => {
    mockGetJob.mockResolvedValue(job());
    mockEnumerate.mockRejectedValue(new Error('listing blew up'));

    await handler(payload, context, generousBudget);

    const saved = lastSavedJob();
    expect(saved.status).toBe(BulkDeleteJobStatus.Failed);
    expect(saved.error).toBe('listing blew up');
  });

  it('fails the job when the tenant is not provisioned in the region', async () => {
    const registry = await import('../lib/service-orchestrator-registry.js');
    vi.mocked(registry.getOrchestratorForRegion).mockReturnValueOnce({
      isTenantReady: () => undefined,
    } as never);
    mockGetJob.mockResolvedValue(job());

    await handler(payload, context, generousBudget);

    expect(lastSavedJob().status).toBe(BulkDeleteJobStatus.Failed);
  });
});
