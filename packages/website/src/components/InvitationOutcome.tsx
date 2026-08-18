import { ApiErrorCode } from '@filone/shared';
import type { AcceptInvitationResponse } from '@filone/shared';

import { Button } from './Button';
import { Link } from './Link';
import { Spinner } from './Spinner';
import { errorCodeOf, errorMessageOf } from '../lib/api.js';
import { ROLE_LABELS } from '../lib/use-member-scope.js';

/**
 * A single centred panel, which is every state this surface has. It sits
 * outside the app shell: the caller is not yet a member of the org they are
 * joining, and the shell would greet them with the not-a-member interstitial.
 */
function Panel({
  title,
  children,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-6">
      <div
        data-testid={testId}
        className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-6 text-center"
      >
        <h1 className="text-base font-medium text-zinc-900">{title}</h1>
        <div className="mt-2 flex flex-col items-center gap-4 text-sm text-zinc-600">
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * What a refusal means, and what the person holding the link can do about it.
 *
 * Expired, revoked, already accepted, and never existed all arrive as one code
 * on purpose — telling them apart would describe other people's invitations to
 * whoever is holding a stale link — so they get one answer here too.
 */
function Refused({
  error,
  sessionEmail,
  onLogOut,
}: {
  error: unknown;
  sessionEmail?: string;
  onLogOut: () => void;
}) {
  const code = errorCodeOf(error);

  if (code === ApiErrorCode.INVITE_EMAIL_MISMATCH) {
    return (
      <Panel title="This invitation is for a different email address" testId="accept-mismatch">
        <p>
          {sessionEmail
            ? `You are signed in as ${sessionEmail}, and this invitation names another address.`
            : 'This invitation names a different address than the account you are signed in with.'}{' '}
          Sign in with the address the invitation was sent to, then open the link again.
        </p>
        <Button variant="primary" size="sm" onClick={onLogOut}>
          Log out
        </Button>
      </Panel>
    );
  }

  if (code === ApiErrorCode.EMAIL_NOT_VERIFIED) {
    return (
      <Panel title="Verify your email address first" testId="accept-unverified">
        <p>
          An invitation is accepted by the address it was sent to, so this account&rsquo;s email has
          to be verified first. The invitation is still waiting — verify, then open the link in the
          invitation email again.
        </p>
        <Link href="/verify-email" variant="accent">
          Verify your email
        </Link>
      </Panel>
    );
  }

  if (code === ApiErrorCode.INVITE_NOT_FOUND) {
    return (
      <Panel title="This invitation is no longer valid" testId="accept-invalid">
        <p>{errorMessageOf(error, 'Ask whoever invited you to send a new invitation.')}</p>
      </Panel>
    );
  }

  return (
    <Panel title="This invitation could not be accepted" testId="accept-failed">
      <p>{errorMessageOf(error, 'Something went wrong. Ask for a new invitation.')}</p>
    </Panel>
  );
}

function Accepted({
  result,
  onContinue,
}: {
  result: AcceptInvitationResponse;
  onContinue: (orgId: string) => void;
}) {
  const orgName = result.orgName || 'your organization';

  return (
    <Panel
      title={result.alreadyMember ? `You are already in ${orgName}` : `You have joined ${orgName}`}
      testId="accept-success"
    >
      <p>
        Your role in {orgName} is {ROLE_LABELS[result.role] ?? result.role}.
      </p>
      {/* Continuing loads the console's root rather than navigating in place: no
          query key carries an org dimension, so a full load is what keeps the
          org this tab was in out of the org it just joined. */}
      <Button
        id="accept-continue-button"
        variant="primary"
        size="sm"
        onClick={() => onContinue(result.orgId)}
      >
        Continue to {orgName}
      </Button>
    </Panel>
  );
}

export type InvitationOutcomeProps = {
  /** Nothing to redeem: the link carried no token, or this page load spent it. */
  status: 'no-token' | 'accepting' | 'accepted' | 'refused';
  result?: AcceptInvitationResponse;
  error?: unknown;
  /** The address this session carries, for the refusal that is about which account it is. */
  sessionEmail?: string;
  onContinue: (orgId: string) => void;
  onLogOut: () => void;
};

/** Every state redeeming an invitation can land in. */
export function InvitationOutcome({
  status,
  result,
  error,
  sessionEmail,
  onContinue,
  onLogOut,
}: InvitationOutcomeProps) {
  if (status === 'no-token') {
    return (
      <Panel title="This invitation link is no longer valid" testId="accept-no-token">
        <p>
          Open the link from the invitation email again. If it keeps landing here, ask whoever
          invited you to send a new one.
        </p>
      </Panel>
    );
  }

  if (status === 'accepted' && result) {
    return <Accepted result={result} onContinue={onContinue} />;
  }

  if (status === 'refused') {
    return <Refused error={error} sessionEmail={sessionEmail} onLogOut={onLogOut} />;
  }

  return (
    <Panel title="Accepting your invitation" testId="accept-pending">
      <Spinner ariaLabel="Accepting the invitation" size={28} />
    </Panel>
  );
}
