// Consumer for the bulk-delete dead-letter queue.
//
// A message only reaches the DLQ after the worker's own retries are spent, and
// the worker marks the job failed itself before letting that last delivery
// throw (see bulk-delete-worker.ts). That covers a *retryable* error. It does
// not cover a hard kill: a Lambda timeout, an OOM, or the process dying
// outright bypasses the worker's own failure handling entirely, so SQS still
// exhausts the delivery count and drops the message here, but the job row is
// left `pending` or `running` with nothing to ever move it again. Without this
// consumer, that job polls forever in the UI. It exists purely to close that
// gap: a non-terminal job whose message reached the DLQ is failed here.

import type { SQSEvent } from 'aws-lambda';

import { isTerminalBulkDeleteStatus } from '@filone/shared';

import { failJob, getBulkDeleteJob, putBulkDeleteJob } from '../lib/bulk-delete-jobs.js';
import type { BulkDeleteWorkerPayload } from '../lib/bulk-delete-queue.js';

const LOG = '[bulk-delete-dlq-watchdog]';

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const { orgId, jobId } = JSON.parse(record.body) as BulkDeleteWorkerPayload;
    const job = await getBulkDeleteJob(orgId, jobId);
    if (!job) {
      console.error(`${LOG} Job not found`, { orgId, jobId });
      continue;
    }
    if (isTerminalBulkDeleteStatus(job.status)) {
      // The worker already recorded its own outcome (e.g. failJob before the
      // final delivery's rethrow); nothing left to do.
      continue;
    }

    console.error(`${LOG} Job stalled: delivery attempts exhausted with no terminal status`, {
      jobId,
    });
    await putBulkDeleteJob(
      failJob(job, 'Bulk deletion stopped after repeated failures and could not be resumed'),
    );
  }
}
