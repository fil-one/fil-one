// Bulk-delete worker: empties a bucket, or everything under a prefix, one
// listing page at a time.
//
// A bucket can hold far more objects than one Lambda invocation can delete, so
// the worker works until the time budget runs low, persists the listing cursor,
// then queues itself a continuation message. The job row in DynamoDB is the
// single source of progress for the polling UI.
//
// Delivery is via SQS (see lib/bulk-delete-queue.ts), which decides how failure
// behaves here. A retryable error is left to escape: the message returns to the
// queue and the next delivery resumes from the last checkpoint. Only a
// non-retryable error, or the last delivery before the dead-letter queue, marks
// the job failed. Swallowing every error into a failed status, as this worker
// used to, turns a transient throttle into a permanently dead job.
//
// Individual object failures (object-lock retention being the common one) are
// recorded and stepped over rather than aborting the run, so one locked object
// cannot strand the rest of the bucket.

import type { Context, SQSEvent, SQSRecord } from 'aws-lambda';

import { BulkDeleteScope, isTerminalBulkDeleteStatus } from '@filone/shared';

import {
  applyPageResult,
  failJob,
  finalizeJob,
  getBulkDeleteJob,
  putBulkDeleteJob,
} from '../lib/bulk-delete-jobs.js';
import {
  MAX_BULK_DELETE_DELIVERY_ATTEMPTS,
  enqueueBulkDeleteJob,
  type BulkDeleteWorkerPayload,
} from '../lib/bulk-delete-queue.js';
import type { BulkDeleteJobRecord } from '../lib/dynamo-records.js';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.js';
import { getOrgProfile } from '../lib/org-profile.js';
import { createS3Client } from '../lib/s3-client.js';
import { getBucketVersioningStatus } from '../lib/s3-bucket-operations.js';
import { deleteTargets, enumerateDeletionPage } from '../lib/s3-bulk-delete.js';

const LOG = '[bulk-delete-worker]';

/**
 * Headroom reserved for the checkpoint write and the queued hand-off. The worker
 * stops starting new pages once less than this remains.
 */
const DEADLINE_BUFFER_MS = 30_000;

/** Objects requested per listing page. Matches the S3 per-page maximum. */
const PAGE_SIZE = 1000;

export type RemainingTimeFn = () => number;

/**
 * An error no amount of redelivery will clear, such as a region the org is not
 * provisioned in. Fails the job on the spot instead of burning every delivery
 * attempt on a retry that cannot succeed.
 */
export class NonRetryableBulkDeleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableBulkDeleteError';
  }
}

export async function handler(event: SQSEvent, context: Context): Promise<void> {
  // One message per invocation (batch size 1), so an error escaping this
  // handler returns exactly the failed job to the queue and never re-runs a
  // sibling that already succeeded.
  for (const record of event.Records) {
    await processRecord(record, () => context.getRemainingTimeInMillis());
  }
}

async function processRecord(record: SQSRecord, getRemainingTimeInMillis: RemainingTimeFn) {
  const payload = JSON.parse(record.body) as BulkDeleteWorkerPayload;
  const deliveryAttempt = Number(record.attributes?.ApproximateReceiveCount ?? '1');
  await processJob(payload, deliveryAttempt, getRemainingTimeInMillis);
}

/**
 * Run one delivery of a job.
 *
 * `deliveryAttempt` is the message's receive count: on the last one the queue
 * has no redelivery left, so the outcome is recorded as a failed job for the
 * user before the message redrives to the dead-letter queue for an operator.
 */
export async function processJob(
  event: BulkDeleteWorkerPayload,
  deliveryAttempt: number,
  getRemainingTimeInMillis: RemainingTimeFn,
): Promise<void> {
  const { orgId, jobId } = event;

  const job = await getBulkDeleteJob(orgId, jobId);
  if (!job) {
    console.error(`${LOG} Job not found`, { orgId, jobId });
    return;
  }
  if (isTerminalBulkDeleteStatus(job.status)) {
    console.warn(`${LOG} Job already finished, skipping`, { jobId, status: job.status });
    return;
  }

  // Track the freshest job state so the failure path records progress made this
  // invocation rather than regressing to the start-of-invocation counts.
  let latestJob = job;
  try {
    const outcome = await runPages(job, getRemainingTimeInMillis, (progressed) => {
      latestJob = progressed;
    });
    if (outcome.exhausted) {
      await putBulkDeleteJob(finalizeJob(outcome.job));
      console.log(`${LOG} Job complete`, {
        jobId,
        deleted: outcome.job.deletedCount,
        failed: outcome.job.failedCount,
      });
      return;
    }

    // Out of time with pages left: checkpoint, then queue the continuation.
    // Persisting the advanced resume count *before* enqueueing matters, because
    // it is the message's deduplication id. A crash between the two is safe:
    // this delivery is redelivered and picks the next count. Enqueueing first
    // would let a redelivery reuse a spent id, and SQS would drop the hand-off.
    const resumeCount = (outcome.job.resumeCount ?? 0) + 1;
    await putBulkDeleteJob({ ...outcome.job, resumeCount });
    await enqueueBulkDeleteJob({ orgId, jobId }, resumeCount);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Bulk delete failed';
    const retryable = !(err instanceof NonRetryableBulkDeleteError);

    if (retryable && deliveryAttempt < MAX_BULK_DELETE_DELIVERY_ATTEMPTS) {
      // Leave the job non-terminal and let the error out: the message goes back
      // on the queue and the next delivery resumes from the last checkpoint.
      console.warn(`${LOG} Delivery failed, will retry`, { jobId, deliveryAttempt, error: err });
      throw err;
    }

    console.error(`${LOG} Job failed`, { jobId, deliveryAttempt, retryable, error: err });
    await putBulkDeleteJob(failJob(latestJob, message));

    // Retries are spent rather than the error being terminal, so let it out
    // once more: the user has a failed job to look at, and the message lands in
    // the dead-letter queue where an operator can still see it.
    if (retryable) throw err;
  }
}

interface RunOutcome {
  job: BulkDeleteJobRecord;
  /** True when the listing walk finished; false when the time budget ran out. */
  exhausted: boolean;
}

async function runPages(
  initial: BulkDeleteJobRecord,
  getRemainingTimeInMillis: RemainingTimeFn,
  onProgress: (job: BulkDeleteJobRecord) => void,
): Promise<RunOutcome> {
  const s3 = createS3Client(await resolveClientContext(initial));
  let job = initial;

  // Only AllVersions ever sees a literal "null" version id (Current lists by
  // key only), and a job's bucket doesn't change mid-run, so this is resolved
  // once per invocation rather than per page.
  const bucketVersioningStatus =
    job.scope === BulkDeleteScope.AllVersions
      ? await getBucketVersioningStatus(s3, job.bucketName)
      : undefined;

  for (;;) {
    const page = await enumerateDeletionPage({
      s3,
      bucket: job.bucketName,
      prefix: job.prefix,
      scope: job.scope,
      ...(job.cursor && { cursor: job.cursor }),
      ...(bucketVersioningStatus && { bucketVersioningStatus }),
      maxKeys: PAGE_SIZE,
    });

    const result = await deleteTargets({
      s3,
      bucket: job.bucketName,
      targets: page.targets,
    });

    job = { ...applyPageResult(job, result), cursor: page.nextCursor };
    onProgress(job);

    if (!page.nextCursor) return { job, exhausted: true };

    // Persist progress every page so a crash resumes from here rather than
    // re-walking the whole bucket.
    await putBulkDeleteJob(job);

    // Lambda's own remaining-time clock, not a wall-clock deadline derived from
    // Date.now(): the wall clock is NTP-adjusted and not guaranteed monotonic,
    // while this is the exact budget Lambda will enforce.
    if (getRemainingTimeInMillis() <= DEADLINE_BUFFER_MS) return { job, exhausted: false };
  }
}

/**
 * Resolve the tenant's S3 credentials for the job's region. Every backend
 * (Aurora, FTH, Forge) supplies these through the same orchestrator method, so
 * the worker needs no per-region knowledge.
 */
async function resolveClientContext(job: BulkDeleteJobRecord) {
  const orchestrator = getOrchestratorForRegion(job.region);
  const tenantId = orchestrator.isTenantReady(await getOrgProfile(job.orgId));
  if (!tenantId) {
    // Provisioning will not appear by itself between deliveries.
    throw new NonRetryableBulkDeleteError(`Tenant is not provisioned in region ${job.region}`);
  }
  return orchestrator.getS3ClientContext(tenantId);
}
