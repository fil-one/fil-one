import { useQuery } from '@tanstack/react-query';
import { Navigate } from '@tanstack/react-router';

import { Alert } from '../components/Alert.js';
import { Button } from '../components/Button.js';
import { getMe } from '../lib/api.js';
import { ME_STALE_TIME, queryKeys } from '../lib/query-client.js';
import { RagPipelineFrame, RagPipelinePage, RagPipelineSkeleton } from './RagPipelinePage.js';

/**
 * Bucket Intelligence entry point.
 *
 * Allowlisted users (`ragAccess`: Foundation email or the DynamoDB allowlist,
 * computed server-side in `/me`) get the feature. Everyone else is sent to the
 * dashboard, since the sidebar does not link them here; `replace` so the back
 * button skips this page. Reads the same cached `/me` query as `useRagAccess`,
 * but also waits on its loading state so an allowlisted user is never sent away
 * before `/me` resolves.
 *
 * `/me` is usually cached by the time this renders (the app layout reads it
 * first), but an organization switch clears the cache and a failed read lets the
 * layout through without it. While it loads the page shows its own layout; if it
 * fails the page says so and offers a retry, instead of waiting forever.
 */
export function BucketIntelligencePage() {
  const {
    data: me,
    isError,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => getMe(),
    staleTime: ME_STALE_TIME,
  });

  // Data first: a background refetch that fails keeps the `/me` already held,
  // and that answer still decides access.
  if (me) return me.ragAccess ? <RagPipelinePage /> : <Navigate to="/dashboard" replace />;

  if (!isError) return <RagPipelineSkeleton />;

  return (
    <RagPipelineFrame testId="bucket-intelligence-error">
      <Alert
        variant="red"
        title="This page did not load"
        description="We could not load your account details."
        action={
          <Button variant="tertiary" size="sm" disabled={isFetching} onClick={() => void refetch()}>
            Try again
          </Button>
        }
      />
    </RagPipelineFrame>
  );
}
