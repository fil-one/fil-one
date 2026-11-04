import { useEffect, useRef, useState } from 'react';
import { ApiErrorCode } from '@filone/shared';
import type { AcceptInvitationResponse } from '@filone/shared';

import { InvitationOutcome } from '../components/InvitationOutcome';
import type { InvitationOutcomeProps } from '../components/InvitationOutcome';
import { switchToOrg } from '../lib/active-org.js';
import { errorCodeOf, errorStatusOf, getMe, logout, sessionEmailOf } from '../lib/api.js';
import { cacheInviteToken } from '../lib/invite-token.js';
import { acceptInvitation } from '../lib/members-api.js';

/** What the one call this page makes has come back with, if it has. */
type Outcome =
  | { status: 'accepting' }
  | { status: 'accepted'; result: AcceptInvitationResponse }
  | { status: 'refused'; error: unknown };

/**
 * Redeem an invitation token.
 *
 * The token arrives as a prop rather than being read here, because reading it
 * means stripping it out of the URL, and that has to happen in the route's
 * `beforeLoad` — ahead of any render, any query, and any breadcrumb a later
 * navigation would leave behind.
 *
 * The outcome is held in state rather than by `useMutation`, which is the one
 * place in the console that departs from the house pattern. A mutation is
 * something a person clicks; this fires from an effect on mount, and strict mode
 * tears effects down and re-runs them — which detaches the mutation observer
 * from the request already in flight, so the answer arrives with nobody
 * listening and the page waits on a spinner that never resolves. State survives
 * that, and a single-use token cannot be retried into working again.
 */
export function AcceptInvitationPage({ token }: { token: string | null }) {
  const [outcome, setOutcome] = useState<Outcome>({ status: 'accepting' });

  // Once. React runs effects twice in development's strict mode, and the token
  // is single-use: a second attempt would spend the invitation the first one is
  // still redeeming and be answered "no longer valid".
  const started = useRef(false);
  useEffect(() => {
    if (token === null || started.current) return;
    started.current = true;

    void acceptInvitation(token).then(
      async (result) => {
        await refreshSessionClaims();
        setOutcome({ status: 'accepted', result });
      },
      (error: unknown) => {
        // A 401 is the login funnel: `apiRequest` is already navigating, and the
        // token was taken out of storage before this call went out, so without
        // this the trip through Auth0 lands on the dashboard with nothing left
        // to redeem. `sessionStorage` writes land before the navigation does.
        //
        // `EMAIL_NOT_VERIFIED` sends the caller to `/verify-email` next, which is
        // just as much a detour away from this page as the login funnel is — so
        // it gets the same re-stash, and `/verify-email` reads it back to return
        // here instead of landing on the dashboard with the invitation forgotten.
        if (
          errorStatusOf(error) === 401 ||
          errorCodeOf(error) === ApiErrorCode.EMAIL_NOT_VERIFIED
        ) {
          cacheInviteToken(token);
        }
        setOutcome({ status: 'refused', error });
      },
    );
  }, [token]);

  return (
    <InvitationOutcome
      status={statusOf(token, outcome)}
      result={outcome.status === 'accepted' ? outcome.result : undefined}
      error={outcome.status === 'refused' ? outcome.error : undefined}
      // From the refusal itself: a refused caller may have no account `/me` can
      // read, or a deleted one it would answer 410 for.
      sessionEmail={outcome.status === 'refused' ? sessionEmailOf(outcome.error) : undefined}
      onContinue={switchToOrg}
      onLogOut={logout}
    />
  );
}

/**
 * Re-read the session's ID token, which still says the address is unverified
 * when the accept is what verified it. Without this, `_app.tsx`'s `beforeLoad`
 * sends the new member to `/verify-email` as soon as they continue.
 *
 * Only after the accept has answered, so it never races the call that spends
 * the token: two requests in flight over an expired session both answer 401,
 * and if `/me` landed first its navigation to login would cancel the accept.
 * `skipOrgReconcile` because the recovery `/me` normally performs is a page
 * reload, which would drop the outcome this page is about to show. A failure is
 * not the accept's: the membership stands, and the worst it costs is that
 * detour.
 */
async function refreshSessionClaims(): Promise<void> {
  try {
    await getMe({ forceRefresh: true, skipOrgReconcile: true });
  } catch {
    // See above: the accept already succeeded.
  }
}

function statusOf(token: string | null, outcome: Outcome): InvitationOutcomeProps['status'] {
  return token === null ? 'no-token' : outcome.status;
}
