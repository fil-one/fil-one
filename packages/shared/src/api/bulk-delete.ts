import { z } from 'zod';

/**
 * How much of an object's history a bulk delete removes.
 *
 * `current` deletes the live object. On a versioned bucket that writes a delete
 * marker and reclaims no storage, which is usually not what someone emptying a
 * bucket wants, so `allVersions` also removes every non-current version and
 * every delete marker. Only `allVersions` can leave a versioned bucket empty
 * enough for DeleteBucket to succeed.
 */
export const BulkDeleteScope = {
  Current: 'current',
  AllVersions: 'allVersions',
} as const;
export type BulkDeleteScope = (typeof BulkDeleteScope)[keyof typeof BulkDeleteScope];

export const BulkDeleteJobStatus = {
  Pending: 'pending',
  Running: 'running',
  Completed: 'completed',
  /** Ran to completion, but some objects could not be deleted (see `failures`). */
  CompletedWithErrors: 'completedWithErrors',
  Failed: 'failed',
} as const;
export type BulkDeleteJobStatus = (typeof BulkDeleteJobStatus)[keyof typeof BulkDeleteJobStatus];

export const TERMINAL_BULK_DELETE_STATUSES: readonly BulkDeleteJobStatus[] = [
  BulkDeleteJobStatus.Completed,
  BulkDeleteJobStatus.CompletedWithErrors,
  BulkDeleteJobStatus.Failed,
];

export function isTerminalBulkDeleteStatus(status: BulkDeleteJobStatus): boolean {
  return TERMINAL_BULK_DELETE_STATUSES.includes(status);
}

export const CreateBulkDeleteJobSchema = z.object({
  /**
   * Prefix to delete under. The empty string means the whole bucket, which is
   * the "empty this bucket" case, so it is deliberately allowed.
   */
  prefix: z.string().max(1024, 'Prefix is too long').default(''),
  scope: z.enum(BulkDeleteScope).default(BulkDeleteScope.AllVersions),
  /**
   * Caller-supplied key that makes retries safe. Re-posting with the same key
   * returns the existing job instead of starting a second deletion.
   */
  idempotencyKey: z.uuid('Idempotency key must be a UUID'),
});

export type CreateBulkDeleteJobRequest = z.infer<typeof CreateBulkDeleteJobSchema>;

/** A key that could not be deleted, with the reason the gateway gave. */
export interface BulkDeleteFailure {
  key: string;
  versionId?: string;
  code: string;
  /**
   * The gateway's human-readable reason, when it gave one. Absent means no
   * message came back (only the `code`), so callers must not assume a reason is
   * always present.
   */
  message?: string;
}

export interface BulkDeleteJob {
  jobId: string;
  bucketName: string;
  region: string;
  prefix: string;
  scope: BulkDeleteScope;
  status: BulkDeleteJobStatus;
  /** Objects (or versions) successfully deleted so far. */
  deletedCount: number;
  /** Objects the gateway refused to delete, typically object-lock retention. */
  failedCount: number;
  /**
   * A bounded sample of failures for display. `failedCount` is authoritative;
   * this list is capped so one pathological job cannot bloat the record.
   */
  failures: BulkDeleteFailure[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  /** Present when status is Failed: why the job stopped. */
  error?: string;
}

export interface CreateBulkDeleteJobResponse {
  job: BulkDeleteJob;
}

export interface GetBulkDeleteJobResponse {
  job: BulkDeleteJob;
}

/** Cap on `failures` retained in the job record and returned to the client. */
export const MAX_REPORTED_BULK_DELETE_FAILURES = 100;
