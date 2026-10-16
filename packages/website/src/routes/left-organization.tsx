import { createRoute, redirect } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';

import { Route as rootRoute } from './__root.js';
import { LeftLastOrgPage } from '../pages/LeftLastOrgPage.js';
import { getMe } from '../lib/api.js';
import { ME_STALE_TIME, queryClient, queryKeys } from '../lib/query-client.js';

/**
 * Reached when a membership removal (leaving, an admin's removal, or an
 * organization's own deletion) would otherwise drop the caller to zero
 * organizations, and the removal made them an unnamed floor org instead.
 * `_app`'s gate sends them here, and so does leaving the last org from
 * Settings. Outside `_app` for the same reason `/create-organization` is: it
 * is a gate the console sends people to, so it must not sit behind the gate
 * it exists to answer.
 *
 * Anyone else is sent on from `beforeLoad`: a named org has nothing to create,
 * and a new signup's unnamed org belongs on `/create-organization`, which is
 * also where this page's own button goes.
 */
export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/left-organization',
  beforeLoad: async () => {
    if (!document.cookie.includes('hs_logged_in')) {
      throw redirect({ href: '/login', reloadDocument: true });
    }
    let me;
    try {
      me = await queryClient.fetchQuery({
        queryKey: queryKeys.me,
        queryFn: () => getMe(),
        staleTime: ME_STALE_TIME,
      });
    } catch {
      // Network error or 401 (handled by apiRequest): let the page render.
      return;
    }
    if (me.nameConfirmed !== false) {
      throw redirect({ to: '/dashboard' });
    }
    if (!me.floorOrg) {
      throw redirect({ to: '/create-organization' });
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
