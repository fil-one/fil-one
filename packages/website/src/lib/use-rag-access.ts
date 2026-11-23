import { useQuery } from '@tanstack/react-query';

import { getMe } from './api.js';
import { ME_STALE_TIME, queryKeys } from './query-client.js';

/**
 * Whether the current user may access the RAG feature.
 *
 * Reads the `ragAccess` flag computed server-side by `getMe()` (Foundation
 * email OR runtime DynamoDB allowlist) so the gate decision stays consistent
 * between the frontend and backend without a second lookup. Returns `false`
 * while the `/me` query is loading, a safe default that avoids briefly
 * exposing the feature. The sidebar uses it to hide the Bucket Intelligence
 * link. `BucketIntelligencePage` reads `/me` itself instead, because it must
 * tell loading apart from no access before it redirects.
 */
export function useRagAccess(): boolean {
  const { data: me } = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => getMe(),
    staleTime: ME_STALE_TIME,
  });
  return me?.ragAccess ?? false;
}
