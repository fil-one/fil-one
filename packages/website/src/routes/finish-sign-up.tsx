import { useEffect } from 'react';
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
  const {
    data: me,
    isPending,
    isError,
  } = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => getMe(),
    staleTime: ME_STALE_TIME,
  });

  useEffect(() => {
    if (!me) return;
    if (!me.emailVerified) {
      void navigate({ to: '/verify-email' });
    } else if (me.orgConfirmed) {
      void navigate({ to: '/dashboard' });
    }
  }, [me, navigate]);

  if (isPending || !me) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-zinc-500">Loading...</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-zinc-500">Something went wrong. Please refresh and try again.</p>
      </div>
    );
  }

  return <FinishSignUpPage me={me} onComplete={() => navigate({ to: '/dashboard' })} />;
}
