import { createRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';

import { Route as rootRoute } from './__root.js';
import { WelcomePage } from '../pages/WelcomePage.js';
import { getMe } from '../lib/api.js';
import { ME_STALE_TIME, queryKeys } from '../lib/query-client.js';

/**
 * The naming step, outside `_app` for the same reason `/verify-email` is: it is
 * a gate the console sends people to, so it must not sit behind the gate.
 *
 * A caller who arrives with the name already confirmed is sent on rather than
 * shown a step they have finished, which is what makes the redirect safe to
 * follow after saving.
 */
export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/create-organization',
  beforeLoad: () => {
    if (!document.cookie.includes('hs_logged_in')) {
      throw redirect({ href: '/login', reloadDocument: true });
    }
  },
  component: WelcomeRoute,
});

function WelcomeRoute() {
  const navigate = useNavigate();
  const { data: me } = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => getMe(),
    staleTime: ME_STALE_TIME,
  });

  // Anything but an explicit `false` is already confirmed (an absent value is a
  // pre-flag org), so a caller who lands here without needing the step is sent
  // straight on rather than shown a naming gate they have no reason to see.
  if (me && me.nameConfirmed !== false) {
    void navigate({ href: me.slug ? `/${me.slug}/dashboard` : '/dashboard' });
    return null;
  }

  return (
    <WelcomePage
      suggestedName={me?.orgName ?? ''}
      email={me?.email}
      // The org has had a slug since it was created, well before naming — so
      // this always has one to build the org-scoped href with. The dashboard
      // fallback mirrors the one above rather than pointing at a route that
      // doesn't exist for the (practically unreachable) case it's missing.
      onNamed={() => void navigate({ href: me?.slug ? `/${me.slug}/get-started` : '/dashboard' })}
    />
  );
}
