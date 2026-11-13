import { useQuery } from '@tanstack/react-query';
import { Navigate } from '@tanstack/react-router';

import { Spinner } from '../components/Spinner.js';
import { getMe } from '../lib/api.js';
import { ME_STALE_TIME, queryKeys } from '../lib/query-client.js';
import { RagPipelinePage } from './RagPipelinePage.js';

/**
 * Bucket Intelligence entry point.
 *
 * Allowlisted users (`ragAccess`: Foundation email or the DynamoDB allowlist,
 * computed server-side in `/me`) get the feature. Everyone else is sent to the
 * dashboard, since the sidebar does not link them here; `replace` so the back
 * button skips this page. Reads the same cached `/me` query as `useRagAccess`,
 * but also waits on its loading state so an allowlisted user is never sent away
 * before `/me` resolves.
 */
export function BucketIntelligencePage() {
  const {
    data: me,
    isPending,
    isError,
  } = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => getMe(),
    staleTime: ME_STALE_TIME,
  });

  if (isPending || isError) {
    return (
      <div className="flex items-center justify-center p-16">
        <Spinner ariaLabel="Loading" size={32} />
      </div>
    );
  }

  return me?.ragAccess ? <RagPipelinePage /> : <Navigate to="/dashboard" replace />;
}
