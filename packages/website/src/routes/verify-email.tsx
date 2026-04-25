import { useEffect } from 'react';
import { createRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Route as rootRoute } from './__root.js';
import { VerifyEmailPage } from '../pages/VerifyEmailPage.js';
import { getMe } from '../lib/api.js';
import { queryKeys, ME_STALE_TIME } from '../lib/query-client.js';

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/verify-email',
  beforeLoad: () => {
    if (!document.cookie.includes('hs_logged_in')) {
      throw redirect({ href: '/login', reloadDocument: true });
    }
  },
  component: VerifyEmailRoute,
});

function VerifyEmailRoute() {
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
    if (me?.emailVerified) {
      void navigate({ to: me.orgConfirmed ? '/dashboard' : '/finish-sign-up' });
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

  return (
    <VerifyEmailPage
      me={me}
      onVerified={() => {
        void navigate({ to: me.orgConfirmed ? '/dashboard' : '/finish-sign-up' });
      }}
    />
  );
}
