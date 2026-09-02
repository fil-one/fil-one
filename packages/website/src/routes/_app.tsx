import { createRoute, Outlet, redirect, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Route as rootRoute } from './__root';
import { AppShell } from '../components/AppShell';
import { Button } from '../components/Button';
import { getMe, logout } from '../lib/api.js';
import { queryClient, queryKeys, ME_STALE_TIME } from '../lib/query-client.js';
import { usePermissions } from '../lib/use-permissions.js';
import { consumePendingMfaAction } from '../lib/step-up.js';
import { hasPendingInviteToken } from '../lib/invite-token.js';
import { useEffect } from 'react';

export const Route = createRoute({
  id: 'app',
  getParentRoute: () => rootRoute,
  beforeLoad: async () => {
    if (!document.cookie.includes('hs_logged_in')) {
      throw redirect({ href: '/login', reloadDocument: true });
    }
    // An invitation was mid-acceptance when the login bounce happened. The auth
    // flow has no `returnTo` and lands every login on `/dashboard`, so this is
    // the return trip — ahead of the `/me` fetch below, because the accept call
    // is what decides which org `/me` should be answering about.
    if (hasPendingInviteToken()) {
      throw redirect({ to: '/invite/accept' });
    }
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
    // A new account has a derived organization name nobody has looked at. The
    // naming step runs after verification so the two gates cannot both claim
    // the page, and only ever for an organization created since the flag
    // shipped: an absent value reads as confirmed.
    if (!me.nameConfirmed) {
      throw redirect({ to: '/welcome' });
    }
  },
  component: AppWithOrgGuard,
});

/**
 * What a caller with no membership row sees.
 *
 * `usePermissions` has reported this state since permissions arrived, and
 * nothing consumed it: the console rendered the full shell, every request 403'd
 * with `not_a_member`, and the caller was left reading a dashboard of empty
 * counters. The two ways out are a re-read of `/me` — the usual cause is an
 * invite accepted in another tab, or a conversion that had not finished writing
 * the row — and signing out.
 */
function NotAMember() {
  const client = useQueryClient();

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-6">
      <div
        data-testid="not-a-member"
        className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-6 text-center"
      >
        <h1 className="text-base font-medium text-zinc-900">
          Your account is not a member of this organization
        </h1>
        <p className="mt-2 text-sm text-zinc-600">
          Ask an organization owner to invite you. If you have just been added, refresh to pick up
          the change.
        </p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <Button
            id="not-a-member-refresh-button"
            variant="primary"
            size="sm"
            onClick={() => void client.invalidateQueries({ queryKey: queryKeys.me })}
          >
            Refresh
          </Button>
          <Button variant="ghost" size="sm" onClick={logout}>
            Log out
          </Button>
        </div>
      </div>
    </div>
  );
}

function AppWithOrgGuard() {
  const navigate = useNavigate();
  const { isNotAMember } = usePermissions();

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

  if (isNotAMember) return <NotAMember />;

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
