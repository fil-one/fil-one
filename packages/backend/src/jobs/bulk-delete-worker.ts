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

import { BulkDeleteScope, isTerminalBulkDeleteStatus, roleHasPermission } from '@filone/shared';

import { canBulkDelete } from '../lib/bulk-delete-access.ts';
import {
  applyPageResult,
  failJob,
  finalizeJob,
  getBulkDeleteJob,
  putBulkDeleteJob,
} from '../lib/bulk-delete-jobs.ts';
import {
  MAX_BULK_DELETE_DELIVERY_ATTEMPTS,
  enqueueBulkDeleteJob,
  type BulkDeleteWorkerPayload,
} from '../lib/bulk-delete-queue.ts';
import type { BulkDeleteJobRecord } from '../lib/dynamo-records.ts';
import { getScopedMemberId } from '../lib/member-scope.ts';
import { resolveMembership } from '../lib/org-membership.ts';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.ts';
import type { RegionOrchestrator } from '../lib/service-orchestrator.ts';
import { getOrgProfile } from '../lib/org-profile.ts';
import { createS3Client } from '../lib/s3-client.ts';
import {
  getBucketVersioningStatus,
  type BucketVersioningStatus,
} from '../lib/s3-bucket-operations.ts';
import { deleteTargets, enumerateDeletionPage } from '../lib/s3-bulk-delete.ts';

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

interface ResolvedTenant {
  orchestrator: RegionOrchestrator;
  tenantId: string;
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
  const tenant = await resolveTenant(initial);
  const s3 = createS3Client(await tenant.orchestrator.getS3ClientContext(tenant.tenantId));
  let job = initial;

  // A job's bucket doesn't change mid-run, so its versioning is read once per
  // invocation, for the access checks and the walk.
  const bucketVersioningStatus = await getBucketVersioningStatus(s3, job.bucketName);

  for (;;) {
    // The tenant's credentials delete without any policy evaluation, so the
    // starter's role and access are re-checked before every page: a change
    // made after the job was queued, or mid-run, stops it within a page.
    await assertCanDelete(tenant, job, bucketVersioningStatus);

    const page = await enumerateDeletionPage({
      s3,
      bucket: job.bucketName,
      prefix: job.prefix,
      scope: job.scope,
      ...(job.cursor && { cursor: job.cursor }),
      // Only AllVersions ever sees a literal "null" version id; Current lists
      // by key only.
      ...(job.scope === BulkDeleteScope.AllVersions && { bucketVersioningStatus }),
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
 * Fail the job when its starter may no longer run it: their current role must
 * hold `objects.delete`, and a scoped member's bucket policies must still cover
 * the deletion. Neither will be undone by redelivery.
 */
async function assertCanDelete(
  { orchestrator, tenantId }: ResolvedTenant,
  job: BulkDeleteJobRecord,
  bucketVersioningStatus: BucketVersioningStatus,
): Promise<void> {
  const memberId = await resolveStarterScope(job);
  const access = await canBulkDelete(orchestrator, tenantId, memberId, {
    bucketName: job.bucketName,
    scope: job.scope,
    getVersioningStatus: async () => bucketVersioningStatus,
  });
  if (!access.ok) {
    throw new NonRetryableBulkDeleteError(
      `Your access to ${job.bucketName} no longer permits bulk deletion`,
    );
  }
}

/**
 * The member the starter's deletion is scoped to, or undefined for a starter
 * the console serves unscoped, read from their current role. Fails the job when
 * the starter is no longer a member or no longer holds `objects.delete`.
 */
async function resolveStarterScope(job: BulkDeleteJobRecord): Promise<string | undefined> {
  // Queued before the starter was recorded.
  if (!job.startedBy) return undefined;
  const membership = await resolveMembership(job.orgId, job.startedBy);
  if (!membership || !roleHasPermission(membership.role, 'objects.delete')) {
    throw new NonRetryableBulkDeleteError('Your role no longer permits deleting objects');
  }
  return getScopedMemberId(membership.role, job.startedBy);
}

/**
 * Resolve the tenant for the job's region. Every backend (Aurora, FTH, Forge)
 * supplies its S3 credentials through the same orchestrator method, so the
 * worker needs no per-region knowledge.
 */
async function resolveTenant(job: BulkDeleteJobRecord): Promise<ResolvedTenant> {
  const orchestrator = getOrchestratorForRegion(job.region);
  const tenantId = orchestrator.isTenantReady(await getOrgProfile(job.orgId));
  if (!tenantId) {
    // Provisioning will not appear by itself between deliveries.
    throw new NonRetryableBulkDeleteError(`Tenant is not provisioned in region ${job.region}`);
  }
  return { orchestrator, tenantId };
}
