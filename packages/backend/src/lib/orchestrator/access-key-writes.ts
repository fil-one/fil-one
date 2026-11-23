// Access key creation, retried when the storage system reports a concurrent
// write to the tenant's keys.

import pRetry from 'p-retry';
import {
  postTenantsByTenantIdAccessKeys,
  type Options,
  type PostTenantsByTenantIdAccessKeysData,
} from '@filone/orchestrator-client';
import { AccessKeyConcurrentChangeError } from '../errors.ts';
import { extractApiCode } from './api-message.ts';

const KEY_CREATE_RETRY = { retries: 2, minTimeout: 200, maxTimeout: 1000 } as const;

/**
 * Creates an access key, sending the same request again while the storage
 * system answers 409 `ConcurrentChange`. That answer means the creation was
 * rolled back and nothing was written, so a repeat is safe. When every attempt
 * gets it, this throws {@link AccessKeyConcurrentChangeError}.
 *
 * Any other answer, including a 409 for a name the tenant already holds, comes
 * back as the SDK result for the caller to read.
 */
export function createAccessKeyWithRetry(
  options: Omit<Options<PostTenantsByTenantIdAccessKeysData, false>, 'throwOnError'>,
) {
  return pRetry(
    async () => {
      const result = await postTenantsByTenantIdAccessKeys({ ...options, throwOnError: false });
      if (result.response?.status === 409 && extractApiCode(result.error) === 'ConcurrentChange') {
        throw new AccessKeyConcurrentChangeError({ cause: result.error });
      }
      return result;
    },
    {
      ...KEY_CREATE_RETRY,
      // Once the caller's deadline has passed, every further attempt would
      // abort on arrival.
      signal: options.signal ?? undefined,
      shouldRetry: ({ error }) => error instanceof AccessKeyConcurrentChangeError,
    },
  );
}
