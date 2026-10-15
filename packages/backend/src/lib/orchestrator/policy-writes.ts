// The retry rule fil-one/RFC#30 sets for policy and principal writes.

import pRetry from 'p-retry';
import { PolicyConflictError, PolicyPublishError } from '../errors.ts';

const IAM_WRITE_RETRY = { retries: 2, minTimeout: 200, maxTimeout: 1000 } as const;

/**
 * True for the answers fil-one/RFC#30 documents as "retry the same request".
 * A stale precondition is never retried, because the caller must read the
 * current document first, and a refused document never succeeds on a repeat.
 */
function isRetryableWriteError(error: unknown): boolean {
  return error instanceof PolicyConflictError || error instanceof PolicyPublishError;
}

export function withWriteRetry<T>(run: () => Promise<T>): Promise<T> {
  return pRetry(run, {
    ...IAM_WRITE_RETRY,
    shouldRetry: ({ error }) => isRetryableWriteError(error),
  });
}
