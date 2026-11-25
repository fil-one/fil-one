import { useCallback, useEffect, useRef, useState } from 'react';

import {
  BulkDeleteScope,
  isTerminalBulkDeleteStatus,
  type BulkDeleteJob,
  type CreateBulkDeleteJobResponse,
  type GetBulkDeleteJobResponse,
  type S3Region,
} from '@filone/shared';

import { useToast } from '../components/Toast/index.js';
import { apiRequest } from './api.js';

/** How often to ask the API for job progress while it runs. */
export const POLL_INTERVAL_MS = 2000;

export type UseBulkDeleteJobOptions = {
  bucketName: string;
  region: S3Region;
  /** Called once the job reaches a terminal state, for cache invalidation. */
  onFinished?: (job: BulkDeleteJob) => void;
};

export type StartBulkDeleteArgs = {
  prefix?: string;
  scope?: BulkDeleteScope;
};

/** Asks the API to start a bulk deletion, and returns the job it created. */
export async function createBulkDeleteJob(
  bucketName: string,
  region: S3Region,
  { prefix = '', scope = BulkDeleteScope.AllVersions }: StartBulkDeleteArgs,
): Promise<BulkDeleteJob> {
  const params = new URLSearchParams({ region });
  const response = await apiRequest<CreateBulkDeleteJobResponse>(
    `/buckets/${encodeURIComponent(bucketName)}/bulk-delete?${params.toString()}`,
    {
      method: 'POST',
      body: JSON.stringify({
        prefix,
        scope,
        // Makes a retried submit resolve to the same job rather than
        // starting a second deletion.
        idempotencyKey: crypto.randomUUID(),
      }),
    },
  );
  return response.job;
}

/** Reads a bulk deletion's latest progress. */
export async function readBulkDeleteJob(jobId: string): Promise<BulkDeleteJob> {
  const response = await apiRequest<GetBulkDeleteJobResponse>(
    `/bulk-delete-jobs/${encodeURIComponent(jobId)}`,
  );
  return response.job;
}

/**
 * Drives a server-side bulk deletion: creates the job, then polls it to
 * completion. The work happens in a worker, so closing the tab does not stop
 * the deletion; polling only stops watching it.
 */
export function useBulkDeleteJob({ bucketName, region, onFinished }: UseBulkDeleteJobOptions) {
  const { toast } = useToast();
  const [job, setJob] = useState<BulkDeleteJob | null>(null);
  const [starting, setStarting] = useState(false);
  // Held in a ref so the poll effect never restarts when the callback identity
  // changes, which would reset the interval on every render.
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const start = useCallback(
    async (args: StartBulkDeleteArgs = {}) => {
      setStarting(true);
      try {
        const created = await createBulkDeleteJob(bucketName, region, args);
        setJob(created);
        return created;
      } catch (err) {
        console.error('Failed to start bulk delete:', err);
        toast.error(err instanceof Error ? err.message : 'Failed to start deletion');
        return undefined;
      } finally {
        setStarting(false);
      }
    },
    [bucketName, region, toast],
  );

  const isRunning = job !== null && !isTerminalBulkDeleteStatus(job.status);

  useEffect(() => {
    if (!isRunning || !job) return;

    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const latest = await readBulkDeleteJob(job.jobId);
          if (cancelled) return;
          setJob(latest);
          if (isTerminalBulkDeleteStatus(latest.status)) {
            onFinishedRef.current?.(latest);
          }
        } catch (err) {
          // A transient poll failure is not a job failure; keep watching.
          console.error('Failed to read bulk delete progress:', err);
        }
      })();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isRunning, job]);

  const reset = useCallback(() => setJob(null), []);

  return { start, reset, job, starting, isRunning };
}
