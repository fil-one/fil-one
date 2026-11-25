import { describe, it, expect } from 'vitest';

import {
  BulkDeleteJobStatus,
  BulkDeleteScope,
  S3Region,
  type BulkDeleteJob,
  type BulkDeleteJobStatus as Status,
} from '@filone/shared';

import {
  describeBulkDeleteOutcome,
  describeFolderDeleteOutcome,
  summarizeBulkDeleteJobs,
} from './bulk-delete-outcome.js';

/** A finished job; each test sets only what it is about. */
function job(overrides: Partial<BulkDeleteJob> = {}): BulkDeleteJob {
  return {
    jobId: 'any-job',
    bucketName: 'any-bucket',
    region: S3Region.EuWest1,
    prefix: 'any-folder/',
    scope: BulkDeleteScope.AllVersions,
    status: BulkDeleteJobStatus.Completed,
    deletedCount: 0,
    failedCount: 0,
    failures: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const { Completed, CompletedWithErrors, Failed, Pending, Running } = BulkDeleteJobStatus;

describe('summarizeBulkDeleteJobs', () => {
  it.each<[string, Status[], Status]>([
    ['completed when every job completed', [Completed, Completed], Completed],
    ['running while any job runs', [Completed, Running, Failed], Running],
    ['pending while a job waits and none runs', [Completed, Pending], Pending],
    ['failed when a job failed, over one with errors', [CompletedWithErrors, Failed], Failed],
    [
      'completed with errors when one job left objects',
      [Completed, CompletedWithErrors],
      CompletedWithErrors,
    ],
  ])('reads as %s', (_, statuses, expected) => {
    const summary = summarizeBulkDeleteJobs(statuses.map((status) => job({ status })));
    expect(summary.status).toBe(expected);
  });

  it('adds up the counts and failures of every job', () => {
    const failure = { key: 'any-key', code: 'AccessDenied' };
    const summary = summarizeBulkDeleteJobs([
      job({ deletedCount: 3, failedCount: 1, failures: [failure] }),
      job({ deletedCount: 4, failedCount: 2, failures: [failure, failure] }),
    ]);
    expect(summary).toMatchObject({
      deletedCount: 7,
      failedCount: 3,
      failures: [failure, failure, failure],
    });
  });

  it("carries the first failed job's error", () => {
    const summary = summarizeBulkDeleteJobs([job(), job({ status: Failed, error: 'any reason' })]);
    expect(summary.error).toBe('any reason');
  });
});

describe('describeBulkDeleteOutcome', () => {
  it('titles a full deletion with the title it is given', () => {
    expect(describeBulkDeleteOutcome(job({ deletedCount: 1200 }), 'Folder deleted')).toStrictEqual({
      tone: 'success',
      title: 'Folder deleted',
      description: `Deleted ${(1200).toLocaleString()} objects.`,
    });
  });

  it('says why objects remain when every failure gives the same reason', () => {
    const failure = { key: 'any-key', code: 'AccessDenied', message: 'under retention' };
    const outcome = describeBulkDeleteOutcome(
      job({
        status: CompletedWithErrors,
        deletedCount: 1,
        failedCount: 2,
        failures: [failure, failure],
      }),
      'Folder deleted',
    );
    expect(outcome).toStrictEqual({
      tone: 'warning',
      title: 'Some objects remain',
      description:
        "Deleted 1 object. 2 objects couldn't be deleted because they're under retention.",
    });
  });

  it('keeps one period when the reason the provider gives ends in one', () => {
    const failure = { key: 'any-key', code: 'AccessDenied', message: 'Access Denied.' };
    const outcome = describeBulkDeleteOutcome(
      job({ status: CompletedWithErrors, failedCount: 1, failures: [failure] }),
      'Folder deleted',
    );
    expect(outcome.description).toBe(
      "Deleted 0 objects. 1 object couldn't be deleted because it's Access Denied.",
    );
  });

  it('reports a stopped deletion with its error', () => {
    expect(
      describeBulkDeleteOutcome(job({ status: Failed, error: 'any reason' }), 'Folder deleted'),
    ).toStrictEqual({ tone: 'error', title: 'Deletion stopped', description: 'any reason' });
  });
});

describe('describeFolderDeleteOutcome', () => {
  it('reports the folders deleted when every job completed and every folder started', () => {
    const outcome = describeFolderDeleteOutcome(
      [job({ prefix: 'a/', deletedCount: 2 }), job({ prefix: 'b/', deletedCount: 3 })],
      [],
    );
    expect(outcome).toStrictEqual({
      tone: 'success',
      title: 'Folders deleted',
      description: 'Deleted 5 objects.',
    });
  });

  it('names the folder whose job stopped, with its reason, when another folder was emptied', () => {
    const outcome = describeFolderDeleteOutcome(
      [
        job({ prefix: 'a/', deletedCount: 2 }),
        job({ prefix: 'b/', status: Failed, deletedCount: 1, error: 'any reason.' }),
      ],
      [],
    );
    expect(outcome).toStrictEqual({
      tone: 'warning',
      title: 'Some folders remain',
      description: 'Deletion stopped in b/: any reason. Deleted 3 objects.',
    });
  });

  it('names the folders whose job never started', () => {
    const outcome = describeFolderDeleteOutcome([job({ prefix: 'a/', deletedCount: 2 })], ['b/']);
    expect(outcome).toStrictEqual({
      tone: 'warning',
      title: 'Some folders remain',
      description: "Couldn't start deleting b/. Deleted 2 objects.",
    });
  });

  it('reports a stop when no folder was emptied', () => {
    const outcome = describeFolderDeleteOutcome(
      [job({ prefix: 'a/', status: Failed, error: 'any reason' })],
      [],
    );
    expect(outcome).toStrictEqual({
      tone: 'error',
      title: 'Deletion stopped',
      description: 'Deletion stopped in a/: any reason. Deleted 0 objects.',
    });
  });

  it('names three stopped folders and counts the rest', () => {
    const stopped = ['a/', 'b/', 'c/', 'd/', 'e/'].map((prefix) =>
      // No error, so the description names no reason.
      job({ prefix, status: Failed }),
    );
    expect(describeFolderDeleteOutcome(stopped, []).description).toBe(
      'Deletion stopped in a/, b/, c/ and 2 more folders. Deleted 0 objects.',
    );
  });
});
