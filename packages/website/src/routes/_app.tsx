import { createRoute, Outlet, redirect } from '@tanstack/react-router';
import { Route as rootRoute } from './__root';
import { getMe } from '../lib/api.js';
import { queryClient, queryKeys, ME_STALE_TIME } from '../lib/query-client.js';
import { hasPendingInviteToken } from '../lib/invite-token.js';

/**
 * The gates every authenticated page shares, whatever org it ends up scoped
 * to: session, invite-in-progress, verification, naming.
 *
 * Org resolution — matching `$orgSlug` against `/me`'s memberships, and
 * rendering `AppShell` — lives one level down, in `_app/$orgSlug.tsx`. It
 * cannot run here: `/get-started` (first-run setup, before an org has a slug worth
 * putting in a URL) is a direct child of this route rather than of `$orgSlug`,
 * so this layer has to stay slug-agnostic.
 */
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
    // Only an explicit `false` is unconfirmed; an absent value is a pre-flag
    // organization and reads as confirmed, so `!me.nameConfirmed` would wrongly
    // send every such account back through naming.
    if (me.nameConfirmed === false) {
      throw redirect({ to: '/create-organization' });
    }
  },
  component: () => <Outlet />,
});
