import { createRoute, redirect } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';

import { Route as rootRoute } from './__root.js';
import { LeftLastOrgPage } from '../pages/LeftLastOrgPage.js';
import { getMe } from '../lib/api.js';
import { ME_STALE_TIME, queryKeys } from '../lib/query-client.js';

/**
 * Reached when a membership removal (leaving, an admin's removal, or an
 * organization's own deletion) would otherwise drop the caller to zero
 * organizations. Outside `_app` for the same reason `/create-organization`
 * is: it is a gate the console sends people to, so it must not sit behind
 * the gate it exists to answer.
 *
 * UI only for now - nothing yet calls into this route, since the backend
 * side (creating a floor organization lazily, at the moment a removal would
 * otherwise leave zero) is separate, larger work. This is buildable and
 * reviewable on its own first.
 */
export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/left-organization',
  beforeLoad: () => {
    if (!document.cookie.includes('hs_logged_in')) {
      throw redirect({ href: '/login', reloadDocument: true });
    }
  },
  component: LeftLastOrgRoute,
});

function LeftLastOrgRoute() {
  const { data: me } = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => getMe(),
    staleTime: ME_STALE_TIME,
  });

  return <LeftLastOrgPage email={me?.email} />;
}
