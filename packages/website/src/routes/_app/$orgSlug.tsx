import { createRoute, notFound, Outlet, redirect, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Route as appRoute } from '../_app';
import { AppShell } from '../../components/AppShell';
import { BillingRequiredGate } from '../../components/BillingRequiredGate.js';
import { Button } from '../../components/Button';
import { getMe, logout } from '../../lib/api.js';
import { queryClient, queryKeys, ME_STALE_TIME } from '../../lib/query-client.js';
import { usePermissions } from '../../lib/use-permissions.js';
import { consumePendingMfaAction } from '../../lib/step-up.js';
import { findActiveMembership, findMembershipBySlug } from '../../lib/org-membership-slug.js';
import { useEffect } from 'react';

/**
 * The org-scoped parent for every real page of the console: resolves
 * `$orgSlug` against the caller's memberships, then renders `AppShell` around
 * whatever page matched underneath.
 *
 * Split out from `_app.tsx` because `/get-started` — first-run setup, reached before
 * the caller's organization has a slug worth putting in a URL — sits beside
 * this route rather than under it.
 */
export const Route = createRoute({
  getParentRoute: () => appRoute,
  path: '$orgSlug',
  beforeLoad: async ({ params, location }) => {
    // Already primed by `_app`'s own `beforeLoad` on this same navigation, so
    // this is a cache read rather than a second request. `skipSwitchWait` for
    // the same reason `_app.tsx` passes it: on the rare miss where this does
    // issue its own request, it is on a switch's own critical path too.
    const me = await queryClient.fetchQuery({
      queryKey: queryKeys.me,
      queryFn: () => getMe({ skipSwitchWait: true }),
      staleTime: ME_STALE_TIME,
    });

    const requested = findMembershipBySlug(me, params.orgSlug);
    const active = findActiveMembership(me);

    if (!requested) {
      // Never valid, or a real org this caller just isn't operating in right
      // now — one rule for both: land on the active org's dashboard, the same
      // place a caller with no slug in the URL at all would go. No active
      // slug at all (no memberships yet) has nowhere to send them, so it is a
      // real not-found instead.
      if (!active?.slug) throw notFound();
      throw redirect({ href: `/${active.slug}/dashboard`, replace: true });
    }

    if (requested.orgId !== me.orgId) {
      // A real org, just not this tab's active one. The URL never silently
      // adopts another org as active — only the switcher does that — so this
      // redirects to the *active* org's version of the same page, preserving
      // everything after the slug segment rather than dropping to the
      // dashboard.
      if (!active?.slug) throw notFound();
      const rest = location.href.slice(`/${params.orgSlug}`.length);
      throw redirect({ href: `/${active.slug}${rest}`, replace: true });
    }
  },
  component: OrgScopedApp,
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

function OrgScopedApp() {
  const navigate = useNavigate();
  const { isNotAMember, billingActive } = usePermissions();

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
      {/* In place of the routed page, not a redirect: the sidebar (org
          switcher, log out) stays reachable either way, which is all a
          blocked account can still do here. */}
      {billingActive ? <Outlet /> : <BillingRequiredGate />}
    </AppShell>
  );
}
