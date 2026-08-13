import { describe, it, expect } from 'vitest';

import {
  BulkDeleteJobStatus,
  BulkDeleteScope,
  MAX_REPORTED_BULK_DELETE_FAILURES,
  S3Region,
  type BulkDeleteFailure,
} from '@filone/shared';

import { applyPageResult, failJob, finalizeJob, toApiJob } from './bulk-delete-jobs.js';
import type { BulkDeleteJobRecord } from './dynamo-records.js';

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

function failure(key: string): BulkDeleteFailure {
  return { key, code: 'AccessDenied', message: 'Object is under retention' };
}

const now = new Date('2026-02-01T00:00:00.000Z');

describe('applyPageResult', () => {
  it('accumulates deleted and failed counts across pages', () => {
    const first = applyPageResult(
      job(),
      { deleted: 10, failures: [failure('a')], multiDeleteUnsupported: false },
      now,
    );
    const second = applyPageResult(
      first,
      { deleted: 5, failures: [failure('b')], multiDeleteUnsupported: false },
      now,
    );

    expect(second.deletedCount).toBe(15);
    expect(second.failedCount).toBe(2);
    expect(second.failures.map((f) => f.key)).toEqual(['a', 'b']);
  });

  it('marks the job running and stamps updatedAt', () => {
    const result = applyPageResult(
      job(),
      { deleted: 1, failures: [], multiDeleteUnsupported: false },
      now,
    );
    expect(result.status).toBe(BulkDeleteJobStatus.Running);
    expect(result.updatedAt).toBe(now.toISOString());
  });

  it('turns multiDelete off permanently once the gateway rejects it', () => {
    const disabled = applyPageResult(
      job(),
      { deleted: 1, failures: [], multiDeleteUnsupported: true },
      now,
    );
    expect(disabled.multiDelete).toBe(false);

    // A later page that did not re-probe must not turn it back on.
    const later = applyPageResult(
      disabled,
      { deleted: 1, failures: [], multiDeleteUnsupported: false },
      now,
    );
    expect(later.multiDelete).toBe(false);
  });

  it('caps the retained failure list while still counting every failure', () => {
    const many = Array.from({ length: MAX_REPORTED_BULK_DELETE_FAILURES + 50 }, (_, i) =>
      failure(`key-${i}`),
    );

    const result = applyPageResult(
      job(),
      { deleted: 0, failures: many, multiDeleteUnsupported: false },
      now,
    );

    expect(result.failures).toHaveLength(MAX_REPORTED_BULK_DELETE_FAILURES);
    expect(result.failedCount).toBe(many.length);
  });

  it('does not grow the failure list past the cap across pages', () => {
    const full = job({
      failures: Array.from({ length: MAX_REPORTED_BULK_DELETE_FAILURES }, (_, i) =>
        failure(`old-${i}`),
      ),
      failedCount: MAX_REPORTED_BULK_DELETE_FAILURES,
    });

    const result = applyPageResult(
      full,
      { deleted: 0, failures: [failure('new')], multiDeleteUnsupported: false },
      now,
    );

    expect(result.failures).toHaveLength(MAX_REPORTED_BULK_DELETE_FAILURES);
    expect(result.failedCount).toBe(MAX_REPORTED_BULK_DELETE_FAILURES + 1);
  });
});

describe('finalizeJob', () => {
  it('completes cleanly when nothing failed', () => {
    const result = finalizeJob(job({ deletedCount: 10 }), now);
    expect(result.status).toBe(BulkDeleteJobStatus.Completed);
    expect(result.completedAt).toBe(now.toISOString());
  });

  it('flags a completed job that left objects behind', () => {
    const result = finalizeJob(job({ deletedCount: 10, failedCount: 2 }), now);
    expect(result.status).toBe(BulkDeleteJobStatus.CompletedWithErrors);
  });

  it('clears the cursor so a finished job is never resumed', () => {
    const result = finalizeJob(job({ cursor: { keyMarker: 'a.txt' } }), now);
    expect(result.cursor).toBeUndefined();
  });
});

describe('failJob', () => {
  it('records the reason and completes the job', () => {
    const result = failJob(job(), 'tenant credentials unavailable', now);
    expect(result.status).toBe(BulkDeleteJobStatus.Failed);
    expect(result.error).toBe('tenant credentials unavailable');
    expect(result.completedAt).toBe(now.toISOString());
  });
});

describe('toApiJob', () => {
  it('drops storage-only fields', () => {
    const api = toApiJob(job({ deletedCount: 3 }));
    expect(api).not.toHaveProperty('pk');
    expect(api).not.toHaveProperty('ttl');
    expect(api).not.toHaveProperty('cursor');
    expect(api.deletedCount).toBe(3);
  });

  it('omits optional fields that are unset', () => {
    const api = toApiJob(job());
    expect(api).not.toHaveProperty('completedAt');
    expect(api).not.toHaveProperty('error');
  });
});
