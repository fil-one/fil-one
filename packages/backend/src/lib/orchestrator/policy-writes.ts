// The retry rule fil-one/RFC#30 sets for policy and principal writes.

import pRetry from 'p-retry';
import { PolicyPublishError } from '../errors.ts';

const IAM_WRITE_RETRY = { retries: 2, minTimeout: 200, maxTimeout: 1000 } as const;

/**
 * Retries a write the storage system committed nothing for, which fil-one/RFC#30
 * documents as "retry the same request". A refused document never succeeds on a
 * repeat, so nothing else is retried.
 */
export function withWriteRetry<T>(run: () => Promise<T>): Promise<T> {
  return pRetry(run, {
    ...IAM_WRITE_RETRY,
    shouldRetry: ({ error }) => error instanceof PolicyPublishError,
  });
}
