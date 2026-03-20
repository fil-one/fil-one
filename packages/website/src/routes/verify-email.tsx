import { createRoute, redirect, useNavigate } from '@tanstack/react-router';
import { Route as rootRoute } from './__root.js';
import { VerifyEmailPage } from '../pages/VerifyEmailPage.js';
import { getMe } from '../lib/api.js';
import { useState, useEffect } from 'react';
import type { MeResponse } from '@filone/shared';

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/verify-email',
  beforeLoad: () => {
    if (!document.cookie.includes('hs_logged_in')) {
      throw redirect({ to: '/sign-in' });
    }
  },
  component: VerifyEmailRoute,
});

function VerifyEmailRoute() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getMe()
      .then((data) => {
        if (data.emailVerified) {
          // Already verified — move to next step
          if (!data.orgConfirmed) {
            void navigate({ to: '/finish-sign-up' });
          } else {
            void navigate({ to: '/dashboard' });
          }
          return;
        }
        setMe(data);
      })
      .catch(() => {
        // If /me fails, let the app handle it (likely a 401 redirect)
      })
      .finally(() => setLoading(false));
  }, [navigate]);

  if (loading || !me) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-zinc-500">Loading...</p>
      </div>
    );
  }

  return (
    <VerifyEmailPage
      me={me}
      onVerified={() => {
        if (!me.orgConfirmed) {
          void navigate({ to: '/finish-sign-up' });
        } else {
          void navigate({ to: '/dashboard' });
        }
      }}
    />
  );
}
