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
  path: '/welcome',
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

  if (me?.nameConfirmed) {
    void navigate({ to: '/dashboard' });
    return null;
  }

  return (
    <WelcomePage
      suggestedName={me?.orgName ?? ''}
      onNamed={() => void navigate({ to: '/dashboard' })}
    />
  );
}
