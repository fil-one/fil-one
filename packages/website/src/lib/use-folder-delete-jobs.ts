import { useCallback, useEffect, useRef, useState } from 'react';

import { isTerminalBulkDeleteStatus, type BulkDeleteJob, type S3Region } from '@filone/shared';

import { useToast } from '../components/Toast/index.js';
import { POLL_INTERVAL_MS, createBulkDeleteJob, readBulkDeleteJob } from './use-bulk-delete-job.js';

export type UseFolderDeleteJobsOptions = {
  bucketName: string;
  region: S3Region;
  /** Called once every job has reached a terminal state, for cache invalidation. */
  onFinished?: (jobs: BulkDeleteJob[]) => void;
};

function isFinished(jobs: BulkDeleteJob[]): boolean {
  return jobs.every((job) => isTerminalBulkDeleteStatus(job.status));
}

/**
 * Reads the latest progress of every job still running, and returns the whole
 * set with those updated. Undefined when no read succeeded, so there is
 * nothing new to show.
 */
async function readRunningJobs(jobs: BulkDeleteJob[]): Promise<BulkDeleteJob[] | undefined> {
  const running = jobs.filter((job) => !isTerminalBulkDeleteStatus(job.status));
  const results = await Promise.allSettled(running.map((job) => readBulkDeleteJob(job.jobId)));
  const latest = new Map<string, BulkDeleteJob>();
  for (const result of results) {
    // A transient poll failure is not a job failure; keep watching.
    if (result.status === 'rejected') {
      console.error('Failed to read folder deletion progress:', result.reason);
    } else {
      latest.set(result.value.jobId, result.value);
    }
  }
  if (latest.size === 0) return undefined;
  return jobs.map((job) => latest.get(job.jobId) ?? job);
}

/** The toast for folders whose deletion never started. */
function describeStartFailure(failed: number, total: number, firstError: unknown): string {
  if (failed === total && total === 1 && firstError instanceof Error) return firstError.message;
  const noun = total === 1 ? 'folder' : 'folders';
  return failed === total
    ? `Couldn't start deleting the ${noun}`
    : `Couldn't start deleting ${failed} of ${total} ${noun}`;
}

/**
 * Deletes folders on the server: one bulk delete job per folder prefix, polled
 * together until every one finishes. A folder is listed a page at a time, so
 * the browser never holds all of its keys; the job lists and deletes them where
 * they live. Like `useBulkDeleteJob`, closing the tab stops only the watching.
 */
export function useFolderDeleteJobs({
  bucketName,
  region,
  onFinished,
}: UseFolderDeleteJobsOptions) {
  const { toast } = useToast();
  const [jobs, setJobs] = useState<BulkDeleteJob[]>([]);
  const [starting, setStarting] = useState(false);
  // Held in a ref so the poll effect never restarts when the callback identity
  // changes, which would reset the interval on every render.
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const start = useCallback(
    async (prefixes: string[]) => {
      setStarting(true);
      try {
        const results = await Promise.allSettled(
          prefixes.map((prefix) => createBulkDeleteJob(bucketName, region, { prefix })),
        );
        const started = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
        const refusals = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
        if (refusals.length > 0) {
          console.error('Failed to start folder deletion:', refusals);
          toast.error(describeStartFailure(refusals.length, prefixes.length, refusals[0]));
        }
        setJobs(started);
        // A folder with nothing left in it can finish before the first poll.
        if (started.length > 0 && isFinished(started)) onFinishedRef.current?.(started);
        return started;
      } finally {
        setStarting(false);
      }
    },
    [bucketName, region, toast],
  );

  const isRunning = jobs.length > 0 && !isFinished(jobs);

  useEffect(() => {
    if (!isRunning) return;

    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        const next = await readRunningJobs(jobs);
        if (cancelled || !next) return;
        setJobs(next);
        if (isFinished(next)) onFinishedRef.current?.(next);
      })();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isRunning, jobs]);

  const reset = useCallback(() => setJobs([]), []);

  return { start, reset, jobs, starting, isRunning };
}
