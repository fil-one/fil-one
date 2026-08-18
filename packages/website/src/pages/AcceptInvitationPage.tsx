import { useEffect, useRef } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';

import { InvitationOutcome } from '../components/InvitationOutcome';
import type { InvitationOutcomeProps } from '../components/InvitationOutcome';
import { switchToOrg } from '../lib/active-org.js';
import { getMe, logout } from '../lib/api.js';
import { acceptInvitation } from '../lib/members-api.js';
import { ME_STALE_TIME, queryKeys } from '../lib/query-client.js';

/**
 * Redeem an invitation token.
 *
 * The token arrives as a prop rather than being read here, because reading it
 * means stripping it out of the URL, and that has to happen in the route's
 * `beforeLoad` — ahead of any render, any query, and any breadcrumb a later
 * navigation would leave behind.
 */
export function AcceptInvitationPage({ token }: { token: string | null }) {
  const accept = useMutation({ mutationFn: (value: string) => acceptInvitation(value) });

  // The signed-in address, for the one refusal that is about which account this
  // is. Asked alongside the accept rather than before it, so the ordinary path
  // does not wait on it.
  const { data: me } = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => getMe(),
    staleTime: ME_STALE_TIME,
    enabled: token !== null,
  });

  // Once. React runs effects twice in development's strict mode, and the token
  // is single-use: a second attempt would spend the invitation the first one is
  // still redeeming and be answered "no longer valid".
  const started = useRef(false);
  const { mutate } = accept;
  useEffect(() => {
    if (token === null || started.current) return;
    started.current = true;
    mutate(token);
  }, [token, mutate]);

  return (
    <InvitationOutcome
      status={statusOf(token, accept)}
      result={accept.data}
      error={accept.error}
      sessionEmail={me?.email}
      onContinue={switchToOrg}
      onLogOut={logout}
    />
  );
}

function statusOf(
  token: string | null,
  accept: { isSuccess: boolean; isError: boolean },
): InvitationOutcomeProps['status'] {
  if (token === null) return 'no-token';
  if (accept.isSuccess) return 'accepted';
  if (accept.isError) return 'refused';
  return 'accepting';
}
