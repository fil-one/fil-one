// Bulk-delete worker: empties a bucket, or everything under a prefix, one
// listing page at a time.
//
// A bucket can hold far more objects than one Lambda invocation can delete, so
// the worker follows the RAG indexer's pattern: work until the time budget runs
// low, persist the listing cursor, then re-invoke itself to continue. The job
// row in DynamoDB is the single source of progress for the polling UI.
//
// Individual object failures (object-lock retention being the common one) are
// recorded and stepped over rather than aborting the run, so one locked object
// cannot strand the rest of the bucket.

import type { Context } from 'aws-lambda';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

import { isTerminalBulkDeleteStatus } from '@filone/shared';

import {
  applyPageResult,
  failJob,
  finalizeJob,
  getBulkDeleteJob,
  putBulkDeleteJob,
} from '../lib/bulk-delete-jobs.js';
import type { BulkDeleteJobRecord } from '../lib/dynamo-records.js';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.js';
import { getOrgProfile } from '../lib/org-profile.js';
import { createS3Client } from '../lib/s3-client.js';
import { deleteTargets, enumerateDeletionPage } from '../lib/s3-bulk-delete.js';

const LOG = '[bulk-delete-worker]';

/**
 * Headroom reserved for the checkpoint write and the self re-invoke. The worker
 * stops starting new pages once less than this remains.
 */
const DEADLINE_BUFFER_MS = 30_000;

/** Objects requested per listing page. Matches the S3 per-page maximum. */
const PAGE_SIZE = 1000;

export interface BulkDeleteWorkerPayload {
  orgId: string;
  jobId: string;
}

export type RemainingTimeFn = () => number;

const lambda = new LambdaClient({});

export async function handler(
  event: BulkDeleteWorkerPayload,
  context: Context,
  getRemainingTimeInMillis: RemainingTimeFn = () => context.getRemainingTimeInMillis(),
): Promise<void> {
  const { orgId, jobId } = event;
  const deadlineEpochMs = computeDeadline(getRemainingTimeInMillis);

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
    const outcome = await runPages(job, deadlineEpochMs, (progressed) => {
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

    // Out of time with pages left: the cursor is already persisted, so continue
    // in a fresh invocation.
    await putBulkDeleteJob(outcome.job);
    await reinvoke({ orgId, jobId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Bulk delete failed';
    console.error(`${LOG} Job failed`, { jobId, error: err });
    await putBulkDeleteJob(failJob(latestJob, message));
  }
}

interface RunOutcome {
  job: BulkDeleteJobRecord;
  /** True when the listing walk finished; false when the time budget ran out. */
  exhausted: boolean;
}

async function runPages(
  initial: BulkDeleteJobRecord,
  deadlineEpochMs: number,
  onProgress: (job: BulkDeleteJobRecord) => void,
): Promise<RunOutcome> {
  const s3 = createS3Client(await resolveClientContext(initial));
  let job = initial;

  for (;;) {
    const page = await enumerateDeletionPage({
      s3,
      bucket: job.bucketName,
      prefix: job.prefix,
      scope: job.scope,
      ...(job.cursor && { cursor: job.cursor }),
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

    if (Date.now() >= deadlineEpochMs) return { job, exhausted: false };
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
    throw new Error(`Tenant is not provisioned in region ${job.region}`);
  }
  return orchestrator.getS3ClientContext(tenantId);
}

async function reinvoke(payload: BulkDeleteWorkerPayload): Promise<void> {
  // The worker cannot link to itself at creation, so `Resource.BulkDeleteWorker`
  // is not injected here; its own function name arrives via env instead (see
  // sst.config.ts). Mirrors RAG_INDEXER_WORKER_FUNCTION_NAME / USAGE_WORKER_*.
  const functionName = process.env.BULK_DELETE_WORKER_FUNCTION_NAME;
  if (!functionName) {
    throw new Error('BULK_DELETE_WORKER_FUNCTION_NAME is not set');
  }
  await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
}

function computeDeadline(getRemainingTimeInMillis: RemainingTimeFn): number {
  const remaining = getRemainingTimeInMillis();
  if (Number.isFinite(remaining) && remaining > DEADLINE_BUFFER_MS) {
    return Date.now() + (remaining - DEADLINE_BUFFER_MS);
  }
  // No reliable signal: take one page and hand off rather than risk a hard stop
  // mid-page with no checkpoint written.
  return 0;
}
