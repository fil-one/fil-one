// Persistence for bulk-delete jobs. The worker reads and rewrites a job row on
// every page, so these helpers keep the marshalling and the failure-list cap in
// one place rather than spread across the worker and the handlers.

import { createHash } from 'node:crypto';

import {
  ConditionalCheckFailedException,
  GetItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';

import {
  BulkDeleteJobStatus,
  MAX_REPORTED_BULK_DELETE_FAILURES,
  type BulkDeleteFailure,
  type BulkDeleteJob,
  type BulkDeleteScope,
  type S3Region,
} from '@filone/shared';

import { getDynamoClient } from './ddb-client.js';
import { BulkDeleteKeys, type BulkDeleteJobRecord } from './dynamo-records.js';

const dynamo = getDynamoClient();

/**
 * Keep finished jobs around long enough for the UI to report the outcome and
 * for someone to inspect failures afterwards, then let them expire.
 */
const JOB_TTL_SECONDS = 7 * 24 * 60 * 60;

export class BulkDeleteJobExistsError extends Error {
  readonly job: BulkDeleteJobRecord;

  constructor(job: BulkDeleteJobRecord) {
    super('A bulk delete job already exists for this request');
    this.name = 'BulkDeleteJobExistsError';
    this.job = job;
  }
}

export interface CreateJobArgs {
  /** Caller-supplied UUID that makes a retry of the same submission idempotent. */
  idempotencyKey: string;
  orgId: string;
  region: S3Region;
  bucketName: string;
  prefix: string;
  scope: BulkDeleteScope;
  now?: Date;
}

/**
 * Derive the job id from the request rather than trusting the caller's key
 * verbatim. Folding every parameter into the id means a resubmit is treated as
 * the same job only when it targets the same bucket, prefix and scope: reusing
 * an idempotency key against different arguments yields a different id and its
 * own job, instead of silently attaching to an unrelated deletion.
 *
 * The idempotency key stays in the hash so two distinct user actions on the same
 * bucket start separate jobs. That is deliberate: a job may already have walked
 * past an object a second user has since uploaded, and only a fresh job re-reads
 * the listing. Concurrent jobs against one bucket are safe because each owns its
 * own row and DeleteObjects is idempotent, so the walks converge on an empty
 * bucket.
 */
export function deriveBulkDeleteJobId(
  args: Pick<
    CreateJobArgs,
    'idempotencyKey' | 'orgId' | 'region' | 'bucketName' | 'prefix' | 'scope'
  >,
): string {
  const canonical = JSON.stringify([
    args.orgId,
    args.region,
    args.bucketName,
    args.prefix,
    args.scope,
    args.idempotencyKey,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Create a job row, failing if one already exists for the same derived id. A
 * duplicate submit (same arguments and idempotency key) lands here and the
 * existing job is returned to the caller instead of a second deletion starting.
 */
export async function createBulkDeleteJob(args: CreateJobArgs): Promise<BulkDeleteJobRecord> {
  const { orgId, region, bucketName, prefix, scope, now = new Date() } = args;
  const jobId = deriveBulkDeleteJobId(args);
  const timestamp = now.toISOString();

  const record: BulkDeleteJobRecord = {
    pk: BulkDeleteKeys.jobPk(orgId),
    sk: BulkDeleteKeys.jobSk(jobId),
    jobId,
    orgId,
    region,
    bucketName,
    prefix,
    scope,
    status: BulkDeleteJobStatus.Pending,
    deletedCount: 0,
    failedCount: 0,
    failures: [],
    startedAt: timestamp,
    updatedAt: timestamp,
    ttl: Math.floor(now.getTime() / 1000) + JOB_TTL_SECONDS,
  };

  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: Resource.BulkDeleteTable.name,
        Item: marshall(record, { removeUndefinedValues: true }),
        // The item is keyed by pk+sk, so guarding on the sort key alone is
        // enough to reject only a re-put of this exact job; other jobs in the
        // same org (same pk, different sk) are unaffected.
        ConditionExpression: 'attribute_not_exists(sk)',
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      const existing = await getBulkDeleteJob(orgId, jobId);
      if (existing) throw new BulkDeleteJobExistsError(existing);
    }
    throw err;
  }

  return record;
}

/**
 * Read a job row.
 *
 * Consistent reads are deliberate on both of this function's callers. The
 * duplicate-submit path reads immediately after a failed conditional put, and an
 * eventually consistent read there can miss the row that just caused the
 * failure. Polling benefits too: a stale read would let the reported progress
 * appear to move backwards between ticks.
 */
export async function getBulkDeleteJob(
  orgId: string,
  jobId: string,
): Promise<BulkDeleteJobRecord | undefined> {
  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.BulkDeleteTable.name,
      Key: {
        pk: { S: BulkDeleteKeys.jobPk(orgId) },
        sk: { S: BulkDeleteKeys.jobSk(jobId) },
      },
      ConsistentRead: true,
    }),
  );
  if (!Item) return undefined;
  return unmarshall(Item) as BulkDeleteJobRecord;
}

/** Overwrite a job row wholesale. The worker owns the row while it runs. */
export async function putBulkDeleteJob(record: BulkDeleteJobRecord): Promise<void> {
  await dynamo.send(
    new PutItemCommand({
      TableName: Resource.BulkDeleteTable.name,
      Item: marshall(record, { removeUndefinedValues: true }),
    }),
  );
}

/**
 * Fold one page's outcome into a job record. Failures accumulate up to a cap so
 * a job against a fully locked bucket cannot grow the item past DynamoDB's
 * 400KB limit; `failedCount` keeps counting regardless.
 */
export function applyPageResult(
  record: BulkDeleteJobRecord,
  page: { deleted: number; failures: BulkDeleteFailure[] },
  now = new Date(),
): BulkDeleteJobRecord {
  const remainingSlots = Math.max(0, MAX_REPORTED_BULK_DELETE_FAILURES - record.failures.length);

  return {
    ...record,
    status: BulkDeleteJobStatus.Running,
    deletedCount: record.deletedCount + page.deleted,
    failedCount: record.failedCount + page.failures.length,
    failures: [...record.failures, ...page.failures.slice(0, remainingSlots)],
    updatedAt: now.toISOString(),
  };
}

/** Terminal state for a job whose listing walk is exhausted. */
export function finalizeJob(record: BulkDeleteJobRecord, now = new Date()): BulkDeleteJobRecord {
  const timestamp = now.toISOString();
  return {
    ...record,
    status:
      record.failedCount > 0
        ? BulkDeleteJobStatus.CompletedWithErrors
        : BulkDeleteJobStatus.Completed,
    cursor: undefined,
    updatedAt: timestamp,
    completedAt: timestamp,
  };
}

export function failJob(
  record: BulkDeleteJobRecord,
  error: string,
  now = new Date(),
): BulkDeleteJobRecord {
  const timestamp = now.toISOString();
  return {
    ...record,
    status: BulkDeleteJobStatus.Failed,
    error,
    updatedAt: timestamp,
    completedAt: timestamp,
  };
}

/** Strip the storage-only fields before returning a job over the API. */
export function toApiJob(record: BulkDeleteJobRecord): BulkDeleteJob {
  return {
    jobId: record.jobId,
    bucketName: record.bucketName,
    region: record.region,
    prefix: record.prefix,
    scope: record.scope,
    status: record.status,
    deletedCount: record.deletedCount,
    failedCount: record.failedCount,
    failures: record.failures,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.completedAt && { completedAt: record.completedAt }),
    ...(record.error && { error: record.error }),
  };
}
