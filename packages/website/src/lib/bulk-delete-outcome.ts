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
    return `${lead} because ${subject} ${trimFinalPeriod(reason)}.`;
  }
  return `${lead}.`;
}

/**
 * A provider's message ends in a period or not, and copy that sets the message
 * inside its own sentence adds one, so drop the message's.
 */
function trimFinalPeriod(message: string): string {
  return message.replace(/\.+$/, '');
}

/** Folders named in a report or confirmation; the rest are counted. */
export const MAX_NAMED_FOLDERS = 3;

/** "a/, b/ and c/", or "a/, b/, c/ and 2 more folders". */
function listFolders(prefixes: string[]): string {
  const named = prefixes.slice(0, MAX_NAMED_FOLDERS);
  const unnamed = prefixes.length - named.length;
  const parts =
    unnamed > 0 ? [...named, `${unnamed} more ${unnamed === 1 ? 'folder' : 'folders'}`] : named;
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** Names the folders whose jobs stopped, with the reason when they share one. */
function describeStopped(stopped: BulkDeleteJob[]): string {
  const reasons = new Set(
    stopped.flatMap((job) => (job.error ? [trimFinalPeriod(job.error)] : [])),
  );
  const [reason] = reasons;
  const because = reasons.size === 1 ? `: ${reason}` : '';
  return `Deletion stopped in ${listFolders(stopped.map((job) => job.prefix))}${because}.`;
}

/**
 * The report for deleting folders, one job per folder. When every folder was
 * emptied it reads as any bulk deletion does. Otherwise it names the folders
 * left: those whose job stopped, and those whose job never started.
 *
 * @param jobs The jobs that started, all finished.
 * @param unstartedPrefixes The folders whose job could not be started.
 */
export function describeFolderDeleteOutcome(
  jobs: BulkDeleteJob[],
  unstartedPrefixes: string[],
): BulkDeleteOutcome {
  const stopped = jobs.filter((job) => job.status === BulkDeleteJobStatus.Failed);
  const finished = jobs.filter((job) => job.status !== BulkDeleteJobStatus.Failed);
  const finishedSummary = summarizeBulkDeleteJobs(finished);
  if (stopped.length === 0 && unstartedPrefixes.length === 0) {
    return describeBulkDeleteOutcome(
      finishedSummary,
      jobs.length === 1 ? 'Folder deleted' : 'Folders deleted',
    );
  }

  const deletedCount = summarizeBulkDeleteJobs(jobs).deletedCount;
  const sentences = [
    ...(stopped.length > 0 ? [describeStopped(stopped)] : []),
    ...(unstartedPrefixes.length > 0
      ? [`Couldn't start deleting ${listFolders(unstartedPrefixes)}.`]
      : []),
    `Deleted ${countObjects(deletedCount)}.`,
    ...(finishedSummary.failedCount > 0 ? [describeFailures(finishedSummary)] : []),
  ];
  // Some folder emptied is a partial result; none is a stop.
  return finished.length > 0
    ? { tone: 'warning', title: 'Some folders remain', description: sentences.join(' ') }
    : { tone: 'error', title: 'Deletion stopped', description: sentences.join(' ') };
}
