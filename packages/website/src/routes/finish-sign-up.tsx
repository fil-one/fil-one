import { createRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Route as rootRoute } from './__root.js';
import { FinishSignUpPage } from '../pages/FinishSignUpPage';
import { getMe } from '../lib/api.js';
import { queryKeys, ME_STALE_TIME } from '../lib/query-client.js';

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/finish-sign-up',
  beforeLoad: () => {
    if (!document.cookie.includes('hs_logged_in')) {
      throw redirect({ href: '/login', reloadDocument: true });
    }
  },
  component: FinishSignUpRoute,
});

function FinishSignUpRoute() {
  const navigate = useNavigate();
  const { data: me, isPending } = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => getMe(),
    staleTime: ME_STALE_TIME,
  });

  if (isPending || !me) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-zinc-500">Loading...</p>
      </div>
    );
  }

  if (!me.emailVerified) {
    void navigate({ to: '/verify-email' });
    return null;
  }

  if (me.orgConfirmed) {
    void navigate({ to: '/dashboard' });
    return null;
  }

  return <FinishSignUpPage me={me} onComplete={() => navigate({ to: '/dashboard' })} />;
}
