import { describe, it, expect, vi, beforeEach } from 'vitest';

import { BulkDeleteJobStatus, BulkDeleteScope, S3Region } from '@filone/shared';

import type { BulkDeleteJobRecord } from '../lib/dynamo-records.js';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    BulkDeleteTable: { name: 'BulkDeleteTable' },
  },
}));

vi.mock('../lib/bulk-delete-jobs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/bulk-delete-jobs.js')>();
  return { ...actual, getBulkDeleteJob: vi.fn() };
});

process.env.FILONE_STAGE = 'test';

import { getBulkDeleteJob } from '../lib/bulk-delete-jobs.js';
import { baseHandler } from './get-bulk-delete-job.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

const mockGet = vi.mocked(getBulkDeleteJob);

function record(overrides: Partial<BulkDeleteJobRecord> = {}): BulkDeleteJobRecord {
  return {
    pk: 'BULKDELETE#org-1',
    sk: 'JOB#job-1',
    jobId: 'job-1',
    orgId: 'org-1',
    region: S3Region.EuWest1,
    bucketName: 'my-bucket',
    prefix: '',
    scope: BulkDeleteScope.AllVersions,
    status: BulkDeleteJobStatus.Running,
    deletedCount: 1200,
    failedCount: 0,
    failures: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    ttl: 1,
    ...overrides,
  };
}

function event(jobId: string | null = 'job-1') {
  const built = buildEvent({ userInfo: { orgId: 'org-1', userId: 'user-1' } });
  if (jobId) built.pathParameters = { jobId };
  return built;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('get-bulk-delete-job', () => {
  it('returns the job with its progress', async () => {
    mockGet.mockResolvedValue(record());

    const result = await baseHandler(event());

    expect(result.statusCode).toBe(200);
    const { job } = JSON.parse(result.body!);
    expect(job.status).toBe(BulkDeleteJobStatus.Running);
    expect(job.deletedCount).toBe(1200);
  });

  it('scopes the lookup to the caller org', async () => {
    mockGet.mockResolvedValue(record());
    await baseHandler(event());
    expect(mockGet).toHaveBeenCalledWith('org-1', 'job-1');
  });

  it('never leaks storage-only fields', async () => {
    mockGet.mockResolvedValue(record({ cursor: { keyMarker: 'secret-marker' } }));

    const { job } = JSON.parse((await baseHandler(event())).body!);

    expect(job).not.toHaveProperty('cursor');
    expect(job).not.toHaveProperty('pk');
    expect(job).not.toHaveProperty('orgId');
  });

  it('404s an unknown job', async () => {
    mockGet.mockResolvedValue(undefined);
    const result = await baseHandler(event());
    expect(result.statusCode).toBe(404);
  });

  it('requires a job id', async () => {
    const result = await baseHandler(event(null));
    expect(result.statusCode).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('reports failures on a job that could not delete everything', async () => {
    mockGet.mockResolvedValue(
      record({
        status: BulkDeleteJobStatus.CompletedWithErrors,
        failedCount: 2,
        failures: [{ key: 'locked.txt', code: 'AccessDenied', message: 'under retention' }],
        completedAt: '2026-01-01T00:05:00.000Z',
      }),
    );

    const { job } = JSON.parse((await baseHandler(event())).body!);

    expect(job.status).toBe(BulkDeleteJobStatus.CompletedWithErrors);
    expect(job.failures[0].key).toBe('locked.txt');
    expect(job.completedAt).toBe('2026-01-01T00:05:00.000Z');
  });
});
