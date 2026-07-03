import { createRoute, redirect } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';
import { RagPipelinePage } from '../../pages/RagPipelinePage';
import { getMe } from '../../lib/api.js';
import { queryClient, queryKeys, ME_STALE_TIME } from '../../lib/query-client.js';

export const Route = createRoute({
  path: '/rag-pipeline',
  getParentRoute: () => appRoute,
  // Guard the route for users without RAG access: hide-and-redirect so the page
  // is unreachable even by direct navigation (the nav item is also hidden).
  // Reuses the same cached `/me` query the nav and useRagAccess read, so no
  // extra request. On a network/auth error we let the page through — the page
  // itself renders a not-available state via useRagAccess as defense in depth.
  beforeLoad: async () => {
    let me;
    try {
      me = await queryClient.fetchQuery({
        queryKey: queryKeys.me,
        queryFn: () => getMe(),
        staleTime: ME_STALE_TIME,
      });
    } catch {
      return;
    }
    if (!me.ragAccess) {
      throw redirect({ to: '/dashboard' });
    }
  },
  component: RagPipelinePage,
});
