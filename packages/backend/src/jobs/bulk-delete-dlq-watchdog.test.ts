import { describe, it, expect, vi, beforeEach } from 'vitest';

import { BulkDeleteJobStatus, BulkDeleteScope, S3Region } from '@filone/shared';

import type { BulkDeleteJobRecord } from '../lib/dynamo-records.js';

vi.mock('../lib/bulk-delete-jobs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/bulk-delete-jobs.js')>();
  return {
    ...actual,
    getBulkDeleteJob: vi.fn(),
    putBulkDeleteJob: vi.fn(),
  };
});

import { getBulkDeleteJob, putBulkDeleteJob } from '../lib/bulk-delete-jobs.js';
import { handler } from './bulk-delete-dlq-watchdog.js';

const mockGetJob = vi.mocked(getBulkDeleteJob);
const mockPutJob = vi.mocked(putBulkDeleteJob);

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
    status: BulkDeleteJobStatus.Running,
    deletedCount: 0,
    failedCount: 0,
    failures: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ttl: 1,
    ...overrides,
  };
}

function record(body: unknown) {
  return { body: JSON.stringify(body) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('bulk-delete DLQ watchdog', () => {
  it('fails a stalled non-terminal job', async () => {
    mockGetJob.mockResolvedValue(job());

    await handler({ Records: [record({ orgId: 'org-1', jobId: 'job-1' })] } as never);

    expect(mockPutJob).toHaveBeenCalledTimes(1);
    const saved = mockPutJob.mock.calls[0][0];
    expect(saved.status).toBe(BulkDeleteJobStatus.Failed);
    expect(saved.error).toBeTruthy();
  });

  it('does nothing when the job already has a terminal status', async () => {
    mockGetJob.mockResolvedValue(job({ status: BulkDeleteJobStatus.Failed, error: 'boom' }));

    await handler({ Records: [record({ orgId: 'org-1', jobId: 'job-1' })] } as never);

    expect(mockPutJob).not.toHaveBeenCalled();
  });

  it('does nothing when the job row is missing', async () => {
    mockGetJob.mockResolvedValue(undefined);

    await handler({ Records: [record({ orgId: 'org-1', jobId: 'job-1' })] } as never);

    expect(mockPutJob).not.toHaveBeenCalled();
  });
});
