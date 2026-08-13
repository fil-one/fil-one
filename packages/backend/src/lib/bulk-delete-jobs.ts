// Persistence for bulk-delete jobs. The worker reads and rewrites a job row on
// every page, so these helpers keep the marshalling and the failure-list cap in
// one place rather than spread across the worker and the handlers.

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
  constructor(public readonly job: BulkDeleteJobRecord) {
    super('A bulk delete job already exists for this idempotency key');
    this.name = 'BulkDeleteJobExistsError';
  }
}

export interface CreateJobArgs {
  jobId: string;
  orgId: string;
  region: S3Region;
  bucketName: string;
  prefix: string;
  scope: BulkDeleteScope;
  now?: Date;
}

/**
 * Create a job row, failing if one already exists for the same id. Because the
 * id is the caller's idempotency key, a duplicate submit lands here and the
 * existing job is returned to the caller instead of a second deletion starting.
 */
export async function createBulkDeleteJob(args: CreateJobArgs): Promise<BulkDeleteJobRecord> {
  const { jobId, orgId, region, bucketName, prefix, scope, now = new Date() } = args;
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
    multiDelete: true,
    startedAt: timestamp,
    updatedAt: timestamp,
    ttl: Math.floor(now.getTime() / 1000) + JOB_TTL_SECONDS,
  };

  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: Resource.BulkDeleteTable.name,
        Item: marshall(record, { removeUndefinedValues: true }),
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
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
  page: { deleted: number; failures: BulkDeleteFailure[]; multiDeleteUnsupported: boolean },
  now = new Date(),
): BulkDeleteJobRecord {
  const remainingSlots = Math.max(0, MAX_REPORTED_BULK_DELETE_FAILURES - record.failures.length);

  return {
    ...record,
    status: BulkDeleteJobStatus.Running,
    deletedCount: record.deletedCount + page.deleted,
    failedCount: record.failedCount + page.failures.length,
    failures: [...record.failures, ...page.failures.slice(0, remainingSlots)],
    multiDelete: record.multiDelete && !page.multiDeleteUnsupported,
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
