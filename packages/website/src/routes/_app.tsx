import { createRoute, Outlet, redirect, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Route as rootRoute } from './__root';
import { AppShell } from '../components/AppShell';
import { getMe } from '../lib/api.js';

export const Route = createRoute({
  id: 'app',
  getParentRoute: () => rootRoute,
  beforeLoad: async () => {
    if (!document.cookie.includes('hs_logged_in')) {
      throw redirect({ to: '/sign-in' });
    }
    // Check if org is confirmed before allowing access to any app route
    let me;
    try {
      me = await getMe();
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

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
