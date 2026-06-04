import { useQuery } from '@tanstack/react-query';

import type { S3Region } from '@filone/shared';
import { getAvailableRegions } from '@filone/shared';

import { FILONE_STAGE } from '../env.js';
import { getMe } from './api.js';
import { queryKeys } from './query-client.js';

/**
 * Regions selectable by the current user, accounting for the Foundation
 * email allowlist: verified `@fil.org` users get early-access regions in
 * production. Use this anywhere region availability is surfaced (the region
 * picker, "more regions coming soon" hints, etc.) so all call sites stay
 * consistent with one another.
 */
export function useAvailableRegions(): S3Region[] {
  const { data: me } = useQuery({ queryKey: queryKeys.me, queryFn: () => getMe() });
  const allowlistEmail = me?.emailVerified ? me.email : undefined;
  return getAvailableRegions(FILONE_STAGE, allowlistEmail);
}
