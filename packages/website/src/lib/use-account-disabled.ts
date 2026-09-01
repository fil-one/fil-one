import { useQuery } from '@tanstack/react-query';

import { getUsage } from './api.js';
import { queryKeys, USAGE_STALE_TIME } from './query-client.js';

/**
 * Whether the org's tenant is disabled, the state the shell's red banner names.
 *
 * A disabled account can read the console but cannot act in it, so the surfaces
 * that offer actions have to know. One definition rather than a `tenantStatus`
 * comparison per page: `write-locked` is a different, narrower state that must
 * not be swept in with it, and that distinction is easy to get wrong twice.
 *
 * Reads the same cached `/usage` query the shell and the dashboard do, so this
 * costs a subscription rather than a request. It answers `false` while that
 * query is still in flight: the status is unknown then, and hiding a control the
 * caller is entitled to is the worse of the two guesses.
 */
export function useAccountDisabled(): boolean {
  const { data: usage } = useQuery({
    queryKey: queryKeys.usage,
    queryFn: getUsage,
    staleTime: USAGE_STALE_TIME,
  });

  return usage?.tenantStatus === 'disabled';
}
