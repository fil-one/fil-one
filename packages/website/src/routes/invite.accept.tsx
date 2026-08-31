import { createRoute, redirect } from '@tanstack/react-router';

import { Route as rootRoute } from './__root.js';
import { AcceptInvitationPage } from '../pages/AcceptInvitationPage.js';
import {
  readAndStripInviteTokenFromHash,
  stashInviteToken,
  takeInviteToken,
} from '../lib/invite-token.js';

/**
 * The route the emailed link names, hanging off the root rather than the app
 * layout: the caller is not yet a member of the org they are joining, and the
 * layout would greet them with the not-a-member interstitial before they could
 * accept.
 *
 * `beforeLoad` is where the token is handled, because everything it does has to
 * happen before anything else on the page: strip it out of the URL, keep it
 * somewhere a navigation cannot lose it, and only then decide whether this
 * caller needs to sign in first.
 */
export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite/accept',
  beforeLoad: () => {
    const fromLink = readAndStripInviteTokenFromHash();
    if (fromLink) stashInviteToken(fromLink);

    // No `returnTo` in the auth flow — every login lands on `/dashboard` — so
    // the token stays stashed across the bounce and the app route sends the
    // caller back here once they are signed in.
    if (!document.cookie.includes('hs_logged_in')) {
      throw redirect({ href: '/login', reloadDocument: true });
    }

    // Taken here rather than on render, so storage is clear before any later
    // redirect could be thrown: a page that then failed to render would
    // otherwise leave the app bouncing back to it forever.
    takeInviteToken();
  },
  component: AcceptInvitationRoute,
});

function AcceptInvitationRoute() {
  return <AcceptInvitationPage token={takeInviteToken()} />;
}
