import { createRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';

import { Route as rootRoute } from './__root.js';
import { WelcomePage } from '../pages/WelcomePage.js';
import { getMe } from '../lib/api.js';
import { ME_STALE_TIME, queryClient, queryKeys } from '../lib/query-client.js';

/**
 * The naming step, outside `_app` for the same reason `/verify-email` is: it is
 * a gate the console sends people to, so it must not sit behind the gate.
 *
 * A caller who arrives with the name already confirmed is sent on from
 * `beforeLoad` rather than shown a step they have finished. That check lives in
 * the load, not the component: saving the name flips `nameConfirmed` to true,
 * so a render-time redirect would re-fire on the re-render that the save
 * triggers and race the freshly-named account off to the dashboard instead of
 * get-started. `beforeLoad` runs once on entry and cannot.
 */
export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/create-organization',
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
      // Network error or 401 (handled by apiRequest) — let the page render and
      // reads inside it deal with the missing session.
      return;
    }
    // Anything but an explicit `false` is already confirmed (an absent value is
    // a pre-flag org), so a caller who no longer needs the step is sent straight
    // on rather than shown a naming gate they have no reason to see.
    if (me.nameConfirmed !== false) {
      throw redirect({ href: me.slug ? `/${me.slug}/dashboard` : '/dashboard' });
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

  return (
    <WelcomePage
      suggestedName={me?.orgName ?? ''}
      email={me?.email}
      // The org has had a slug since it was created, well before naming, so this
      // always has one to build the org-scoped href with. The dashboard fallback
      // points somewhere real for the (practically unreachable) case it's missing.
      onNamed={() => void navigate({ href: me?.slug ? `/${me.slug}/get-started` : '/dashboard' })}
    />
  );
}
