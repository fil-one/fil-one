import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiErrorCode } from '@filone/shared';
import type { AcceptInvitationResponse } from '@filone/shared';

import { InvitationOutcome } from '../components/InvitationOutcome';
import type { InvitationOutcomeProps } from '../components/InvitationOutcome';
import { switchToOrg } from '../lib/active-org.js';
import { errorCodeOf, errorStatusOf, getMe, logout } from '../lib/api.js';
import { stashInviteToken } from '../lib/invite-token.js';
import { acceptInvitation } from '../lib/members-api.js';
import { ME_STALE_TIME, queryKeys } from '../lib/query-client.js';

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

  // The signed-in address, for the one refusal that is about which account this
  // is. Asked only once the accept has been refused, so it never races the call
  // it exists to explain: two requests in flight together over an expired
  // session both answer 401, and whichever lands first starts the navigation to
  // login. If that is `/me`, the accept fetch is cancelled by the unload and
  // rejects as a `TypeError` carrying no status, so the re-stash below never
  // runs and the post-login visit has nothing to redeem. Waiting also drops a
  // request from the path that works.
  //
  // `skipOrgReconcile` because the recovery `/me` normally performs is a page
  // reload, and this page is holding a single-use token in memory. A tab left
  // pointing at an org the caller has since left would reload mid-accept and
  // come back with nothing to redeem.
  const { data: me } = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => getMe({ skipOrgReconcile: true }),
    staleTime: ME_STALE_TIME,
    enabled: token !== null && outcome.status === 'refused',
  });

  // Once. React runs effects twice in development's strict mode, and the token
  // is single-use: a second attempt would spend the invitation the first one is
  // still redeeming and be answered "no longer valid".
  const started = useRef(false);
  useEffect(() => {
    if (token === null || started.current) return;
    started.current = true;

    void acceptInvitation(token).then(
      (result) => setOutcome({ status: 'accepted', result }),
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
          stashInviteToken(token);
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
      sessionEmail={me?.email}
      onContinue={switchToOrg}
      onLogOut={logout}
    />
  );
}

function statusOf(token: string | null, outcome: Outcome): InvitationOutcomeProps['status'] {
  return token === null ? 'no-token' : outcome.status;
}
