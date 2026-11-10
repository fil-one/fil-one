import { BulkDeleteJobStatus, type BulkDeleteJob } from '@filone/shared';

/**
 * The parts of a bulk deletion its report reads. A single job is one, and so
 * is the sum of several jobs started together (see `summarizeBulkDeleteJobs`).
 */
export type BulkDeleteSummary = Pick<
  BulkDeleteJob,
  'status' | 'deletedCount' | 'failedCount' | 'failures' | 'error'
>;

/** How a finished deletion went, which picks the report's icon and colour. */
export type BulkDeleteTone = 'success' | 'warning' | 'error';

export interface BulkDeleteOutcome {
  tone: BulkDeleteTone;
  title: string;
  description: string;
}

/**
 * Several jobs read as one: counts and failures add up, and the status is the
 * worst any job reached. A job still running keeps the whole set running.
 */
export function summarizeBulkDeleteJobs(jobs: BulkDeleteJob[]): BulkDeleteSummary {
  const statuses = new Set(jobs.map((job) => job.status));
  // Unfinished first, then the worse outcome first: the first of these any
  // job holds is the set's status.
  const status =
    [
      BulkDeleteJobStatus.Running,
      BulkDeleteJobStatus.Pending,
      BulkDeleteJobStatus.Failed,
      BulkDeleteJobStatus.CompletedWithErrors,
    ].find((candidate) => statuses.has(candidate)) ?? BulkDeleteJobStatus.Completed;

  return {
    status,
    deletedCount: jobs.reduce((sum, job) => sum + job.deletedCount, 0),
    failedCount: jobs.reduce((sum, job) => sum + job.failedCount, 0),
    failures: jobs.flatMap((job) => job.failures),
    error: jobs.find((job) => job.error)?.error,
  };
}

/**
 * The title and copy a finished deletion reports itself with.
 *
 * @param summary The finished job, or the sum of finished jobs.
 * @param completedTitle The title when everything was deleted, which names what
 *   was emptied ("Bucket empty", "Folder deleted").
 */
export function describeBulkDeleteOutcome(
  summary: BulkDeleteSummary,
  completedTitle: string,
): BulkDeleteOutcome {
  if (summary.status === BulkDeleteJobStatus.Failed) {
    return {
      tone: 'error',
      title: 'Deletion stopped',
      description: summary.error ?? 'The deletion could not be completed.',
    };
  }

  if (summary.status === BulkDeleteJobStatus.CompletedWithErrors) {
    // The counts belong in the description as two sentences. Joining them in
    // the title ("Deleted 4,800, 2,400 left") put a clause comma next to the
    // thousands separators, so the numbers were hard to read apart.
    return {
      tone: 'warning',
      title: 'Some objects remain',
      description: `Deleted ${countObjects(summary.deletedCount)}. ${describeFailures(summary)}`,
    };
  }

  return {
    tone: 'success',
    title: completedTitle,
    description: `Deleted ${countObjects(summary.deletedCount)}.`,
  };
}

function countObjects(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'object' : 'objects'}`;
}

/**
 * Explain why objects survived, collectively rather than by naming a file. We
 * state a reason only when the gateway gave a human message for every recorded
 * failure and they all agree (object-lock retention is the usual one). When any
 * reason is missing, they differ, or more objects failed than we hold reasons
 * for, we keep to the count rather than claim a cause that might not hold. The
 * per-object detail (including any retention window) lives on the object.
 */
function describeFailures(summary: BulkDeleteSummary): string {
  const count = summary.failedCount;
  const lead = `${countObjects(count)} couldn't be deleted`;

  const messages = summary.failures.map((f) => f.message?.trim()).filter((m): m is string => !!m);
  const reasons = new Set(messages);
  // Every one of the failed objects contributed the same message. `messages`
  // reaching `count` also implies we hold a reason for all of them (the sample
  // was not capped), so the collective claim is safe.
  if (messages.length === count && reasons.size === 1) {
    const [reason] = reasons;
    const subject = count === 1 ? "it's" : "they're";
    return `${lead} because ${subject} ${reason}.`;
  }
  return `${lead}.`;
}
