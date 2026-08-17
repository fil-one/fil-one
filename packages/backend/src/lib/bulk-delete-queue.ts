// Delivery for the bulk-delete worker.
//
// The worker is driven by a FIFO queue rather than a direct Lambda invoke. A
// direct invoke leaves no trace when a link in the chain dies: if the process
// is killed after a checkpoint but before it hands off, nothing re-drives it
// and the job sits `running` forever with the UI polling a row that will never
// move again. SQS redelivers once the visibility timeout lapses, and gives up
// into a dead-letter queue after a bounded number of attempts.
//
// FIFO, not standard, because the message group is the job id: SQS keeps at
// most one message per group in flight, so two workers can never walk the same
// job's cursor at once. Deduplication ids are supplied explicitly (content-based
// deduplication stays off) because every continuation message for a job carries
// the same body, and the 5-minute dedup window would silently swallow the
// hand-off and strand the job.

import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Resource } from 'sst';

/**
 * Deliveries of one message before SQS redrives it to the dead-letter queue.
 * Kept in step with the queue's `dlq.retry` in sst.config.ts; the worker uses it
 * to tell a retryable hiccup from the last attempt, which is what it reports to
 * the user as a failure.
 */
export const MAX_BULK_DELETE_DELIVERY_ATTEMPTS = 3;

export interface BulkDeleteWorkerPayload {
  orgId: string;
  jobId: string;
}

const sqs = new SQSClient({});

/**
 * Hand a job to the worker.
 *
 * `sequence` distinguishes the continuation messages of one job: 0 for the
 * initial submission, then the job's resume count for each hand-off. Reusing a
 * value inside the dedup window drops the message, so callers must persist an
 * advanced sequence before enqueueing it, never after.
 */
export async function enqueueBulkDeleteJob(
  payload: BulkDeleteWorkerPayload,
  sequence: number,
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: Resource.BulkDeleteQueue.url,
      MessageBody: JSON.stringify(payload),
      MessageGroupId: payload.jobId,
      MessageDeduplicationId: `${payload.jobId}:${sequence}`,
    }),
  );
}
