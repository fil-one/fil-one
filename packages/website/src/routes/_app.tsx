import { createRoute, Outlet, redirect, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Route as rootRoute } from './__root';
import { AppShell } from '../components/AppShell';
import { getMe } from '../lib/api.js';
import { queryClient, queryKeys, ME_STALE_TIME } from '../lib/query-client.js';
import { consumePendingMfaAction } from '../lib/step-up.js';

export const Route = createRoute({
  id: 'app',
  getParentRoute: () => rootRoute,
  beforeLoad: async () => {
    if (!document.cookie.includes('hs_logged_in')) {
      throw redirect({ href: '/login', reloadDocument: true });
    }
    // Check if org is confirmed before allowing access to any app route.
    // Uses queryClient.fetchQuery so the result is cached — subsequent useQuery(['me'])
    // calls in components will get this data instantly without a second network request.
    let me;
    try {
      me = await queryClient.fetchQuery({
        queryKey: queryKeys.me,
        queryFn: () => getMe(),
        staleTime: ME_STALE_TIME,
      });
    } catch {
      // Network error or 401 (handled by apiRequest) — let the app through
      return;
    }
    if (!me.emailVerified) {
      throw redirect({ to: '/verify-email' });
    }
    if (!me.orgConfirmed) {
      throw redirect({ to: '/finish-sign-up' });
    }
  },
  component: AppWithOrgGuard,
});

function AppWithOrgGuard() {
  const navigate = useNavigate();

  // Listen for org:not-confirmed events from API calls during the session
  useEffect(() => {
    function handleOrgNotConfirmed() {
      void navigate({ to: '/finish-sign-up' });
    }
    window.addEventListener('org:not-confirmed', handleOrgNotConfirmed);
    return () => window.removeEventListener('org:not-confirmed', handleOrgNotConfirmed);
  }, [navigate]);

  // Resume an MFA action after a step-up redirect round-trip. The api wrapper
  // stashes the pending action + return path in sessionStorage before bouncing
  // through Auth0 with prompt=login; the callback lands on /dashboard, then we
  // bounce here to the original page with ?action=<key>.
  useEffect(() => {
    const pending = consumePendingMfaAction();
    if (!pending) return;
    const url = new URL(pending.returnTo, window.location.origin);
    url.searchParams.set('action', pending.action);
    void navigate({ to: url.pathname + url.search, replace: true });
  }, [navigate]);

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
