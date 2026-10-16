import {
  createRoute,
  Navigate,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MeResponse } from '@filone/shared';
import { Route as rootRoute } from './__root';
import { AppShell } from '../components/AppShell';
import { BillingRequiredGate } from '../components/BillingRequiredGate.js';
import { Button } from '../components/Button';
import { getMe, logout } from '../lib/api.js';
import { queryClient, queryKeys, ME_STALE_TIME } from '../lib/query-client.js';
import { usePermissions } from '../lib/use-permissions.js';
import { consumePendingMfaAction } from '../lib/step-up.js';
import { hasPendingInviteToken } from '../lib/invite-token.js';
import { onSwitchingOrgChange, switchToOrg } from '../lib/active-org.js';
import { useEffect, useReducer } from 'react';

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
        queryFn: () => getMe({ skipSwitchWait: true }),
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
    // the page. Only an explicit `false` is unconfirmed: an absent value is a
    // pre-flag organization and reads as confirmed.
    //
    // A floor org (made when the caller lost their last membership) is
    // unnamed too, and the only one they have, but its owner is not new:
    // `/left-organization` says why they have no organization before sending
    // them on to name one.
    const naming = namingRedirect(me);
    if (naming) throw redirect({ to: naming });
  },
  component: AppWithOrgGuard,
});

/**
 * Where an unnamed org the account has nowhere else to be sends it, if
 * anywhere. `AppWithOrgGuard` applies it too: a `/me` refetch that lands on the
 * floor org remounts the outlet without rerunning `beforeLoad`.
 */
function namingRedirect(me: MeResponse): '/left-organization' | '/create-organization' | undefined {
  if (me.nameConfirmed !== false || !isOnlyMembership(me)) return undefined;
  return me.floorOrg ? '/left-organization' : '/create-organization';
}

/**
 * Whether the org `/me` answered for is the only one the account belongs to.
 *
 * Every account has an unnamed personal org from signup, including one that
 * signed up through an invitation and only ever works in the team org. A new
 * tab resolves to that personal org (the tab has not chosen one yet), so
 * asking for a name whenever it is unnamed would stop that person on every
 * fresh tab to name an org they never asked for. The naming step is for an
 * account with nowhere else to be: a brand-new signup.
 */
function isOnlyMembership(me: MeResponse): boolean {
  return (me.memberships?.length ?? 1) <= 1;
}

/**
 * What a caller with no membership row sees.
 *
 * `usePermissions` has reported this state since permissions arrived, and
 * nothing consumed it: the console rendered the full shell, every request 403'd
 * with `not_a_member`, and the caller was left reading a dashboard of empty
 * counters. The ways out are a re-read of `/me` (the usual cause is an invite
 * accepted in another tab, or a conversion that had not finished writing the
 * row) and signing out. An account that still belongs to another org, after
 * leaving or being removed from this one, is also offered that org, since the
 * shell and its switcher are not rendered here.
 */
function NotAMember() {
  const client = useQueryClient();
  const { data: me } = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => getMe(),
    staleTime: ME_STALE_TIME,
  });
  const other = me?.memberships?.find((membership) => membership.orgId !== me.orgId);

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
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {other && (
            <Button variant="primary" size="sm" onClick={() => switchToOrg(other.orgId)}>
              {/* Capped so a long org name truncates inside the button on a
                  375px screen rather than running past its edges. */}
              Go to{' '}
              <span className="inline-block max-w-40 truncate align-bottom">{other.orgName}</span>
            </Button>
          )}
          <Button
            id="not-a-member-refresh-button"
            variant={other ? 'ghost' : 'primary'}
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

/**
 * The pages an org without an active plan still opens: Settings (the caller's
 * own profile, and Leave organization), Edit organization (the danger zone),
 * and Support. None of them reads or stores anything billing pays for, and
 * without them a blocked org could not be left or deleted from the console:
 * an owner who created one and decided not to pay, or a member of one, would
 * have Log out as the only way out.
 */
const PAGES_PAST_THE_BILLING_GATE = new Set(['/settings', '/edit-organization', '/support']);

/** Whether `pathname` is a page the billing gate replaces. */
export function billingGateCovers(pathname: string): boolean {
  return !PAGES_PAST_THE_BILLING_GATE.has(pathname.replace(/\/$/, ''));
}

function AppWithOrgGuard() {
  const navigate = useNavigate();
  const { isNotAMember, billingActive } = usePermissions();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const gated = !billingActive && billingGateCovers(pathname);
  const { data: me } = useQuery({ queryKey: queryKeys.me, queryFn: () => getMe() });

  // A switch clears the cache, and a mounted `useQuery` stays on its removed
  // query until its component renders again. A switch onto the page the tab is
  // already on changes no location, so nothing else re-renders this layout.
  // Re-rendering once the switch commits moves every observer here and in the
  // shell onto the new org's queries, and `me.orgId` re-keys the page. Not
  // when the latch goes up: the cache is empty then, and a `/me` started from
  // here is held by the latch, which `beforeLoad`'s own `/me` could join.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(
    () =>
      onSwitchingOrgChange((next, outcome) => {
        if (outcome === 'committed') rerender();
      }),
    [],
  );

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

  const naming = me && namingRedirect(me);
  if (naming) return <Navigate to={naming} />;
  if (isNotAMember) return <NotAMember />;

  return (
    <AppShell>
      {/* In place of the routed page, not a redirect: the sidebar (org
          switcher, log out) stays reachable either way, and so do the pages
          in `PAGES_PAST_THE_BILLING_GATE`, where a blocked org can still be
          left or deleted.

          Keyed on the org the server answered for, on both branches, so the
          page remounts at the org boundary even when the switch lands on the
          URL the tab is already on. */}
      {gated ? <BillingRequiredGate key={me?.orgId} /> : <Outlet key={me?.orgId} />}
    </AppShell>
  );
}
