import { useEffect, useRef } from 'react';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import { EnvelopeIcon, WarningCircleIcon, WarningIcon } from '@phosphor-icons/react/dist/ssr';
import { ApiErrorCode, OrgRole } from '@filone/shared';
import type { AcceptInvitationResponse } from '@filone/shared';

import { Badge } from './Badge';
import { Button } from './Button';
import { IconBox, type IconBoxColor } from './IconBox';
import { OrgAvatar } from './OrgAvatar';
import { Spinner } from './Spinner';
import { errorCodeOf, errorMessageOf } from '../lib/api.js';
import { ROLE_CAPABILITIES_SELF, ROLE_LABELS } from '../lib/use-member-scope.js';

function RoleBadge({ role, className }: { role: OrgRole; className?: string }) {
  return (
    <Badge
      color={role === OrgRole.Owner ? 'blue' : 'grey'}
      size="sm"
      weight="medium"
      className={className}
    >
      {ROLE_LABELS[role] ?? role}
    </Badge>
  );
}

/**
 * A single centred panel, which is every state this surface has. It sits
 * outside the app shell: the caller is not yet a member of the org they are
 * joining, and the shell would greet them with the not-a-member interstitial.
 *
 * `takeFocus` is for the panels that replace the spinner. The whole page is one
 * panel swapped for another, so a caller who is not watching it has no way to
 * know the wait ended, what it ended as, or that there is now a button — and
 * the live region below only reads the new text out, without moving them to it.
 */
const PANEL_SHELL_CLASSES =
  'w-full max-w-[380px] rounded-xl border border-zinc-200 bg-white p-8 text-center shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.06)]';

function Panel({
  title,
  icon,
  iconColor = 'blue',
  leading,
  children,
  testId,
  takeFocus = false,
}: {
  title: string;
  icon?: PhosphorIcon;
  iconColor?: IconBoxColor;
  /** Overrides `icon`'s IconBox with something else - the org avatar, for the accepted panel. */
  leading?: React.ReactNode;
  children: React.ReactNode;
  testId: string;
  takeFocus?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (takeFocus) heading.current?.focus();
  }, [takeFocus]);

  return (
    <div data-testid={testId} className={PANEL_SHELL_CLASSES}>
      {(leading || icon) && (
        <div className="mb-5 flex justify-center">
          {leading ?? <IconBox icon={icon!} color={iconColor} size="md" />}
        </div>
      )}
      <h1
        ref={heading}
        tabIndex={-1}
        className="text-center text-base font-medium text-zinc-900 outline-none"
      >
        {title}
      </h1>
      <div className="mt-3 flex flex-col items-stretch gap-5 text-center text-sm text-zinc-600">
        {children}
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
      <Panel
        title="Wrong account signed in"
        icon={WarningIcon}
        iconColor="amber"
        testId="accept-mismatch"
        takeFocus
      >
        <p>
          {sessionEmail ? (
            <>
              You&rsquo;re signed in as{' '}
              <span className="font-semibold text-zinc-900">{sessionEmail}</span>.
            </>
          ) : (
            'This invitation was sent to a different address than the account you are signed in with.'
          )}{' '}
          Log out, sign in with the right address, and open the link again.
        </p>
        <Button variant="primary" onClick={onLogOut}>
          Log out
        </Button>
      </Panel>
    );
  }

  if (code === ApiErrorCode.EMAIL_NOT_VERIFIED) {
    return (
      <Panel
        title="Verify your email address first"
        icon={EnvelopeIcon}
        iconColor="blue"
        testId="accept-unverified"
        takeFocus
      >
        <p>
          Your email isn&rsquo;t verified yet, so this invitation is on hold. Verify it and
          we&rsquo;ll bring you straight back here.
        </p>
        <Button variant="primary" href="/verify-email">
          Verify your email
        </Button>
      </Panel>
    );
  }

  if (code === ApiErrorCode.INVITE_NOT_FOUND) {
    return (
      <Panel
        title="This invitation is no longer valid"
        icon={WarningCircleIcon}
        iconColor="red"
        testId="accept-invalid"
        takeFocus
      >
        <p>{errorMessageOf(error, 'Ask an administrator for a new invitation.')}</p>
      </Panel>
    );
  }

  return (
    <Panel
      title="This invitation could not be accepted"
      icon={WarningCircleIcon}
      iconColor="red"
      testId="accept-failed"
      takeFocus
    >
      <p>{errorMessageOf(error, 'Something went wrong. Ask for a new invitation.')}</p>
    </Panel>
  );
}

function Accepted({
  result,
  onContinue,
}: {
  result: AcceptInvitationResponse;
  onContinue: (orgId: string, slug?: string) => void;
}) {
  const orgName = result.orgName || 'your organization';

  return (
    <Panel
      title={result.alreadyMember ? `You're already in ${orgName}` : `Welcome to ${orgName}`}
      leading={<OrgAvatar name={orgName} logoUrl={result.logoUrl} size="md" />}
      testId="accept-success"
      takeFocus
    >
      {/* One sentence with the badge set into it, rather than a "Your role"
          label stacked above the capabilities line: the two read as separate
          fields when the second is just the first explained. The relative
          clause carries straight on from the badge, so no full stop lands
          against its padding. `align-middle` because the badge is inline-flex,
          which otherwise sits low against the text it is set into. */}
      <p>
        Your role is <RoleBadge role={result.role} className="align-middle" /> which lets you{' '}
        {ROLE_CAPABILITIES_SELF[result.role] ?? ''}.
      </p>
      {/* Continuing loads the console's root rather than navigating in place: no
          query key carries an org dimension, so a full load is what keeps the
          org this tab was in out of the org it just joined. */}
      <Button
        id="accept-continue-button"
        variant="primary"
        onClick={() => onContinue(result.orgId, result.slug)}
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
  onContinue: (orgId: string, slug?: string) => void;
  onLogOut: () => void;
};

/**
 * Every state redeeming an invitation can land in.
 *
 * The wrapper is the live region, and it is the same element in every state on
 * purpose: a region announces what changes inside it, so one that is unmounted
 * and replaced along with the panel announces nothing at all.
 */
export function InvitationOutcome({
  status,
  result,
  error,
  sessionEmail,
  onContinue,
  onLogOut,
}: InvitationOutcomeProps) {
  return (
    <div
      aria-live="polite"
      className="flex min-h-screen items-center justify-center bg-zinc-50 px-6"
    >
      {panelFor({ status, result, error, sessionEmail, onContinue, onLogOut })}
    </div>
  );
}

function panelFor({
  status,
  result,
  error,
  sessionEmail,
  onContinue,
  onLogOut,
}: InvitationOutcomeProps) {
  if (status === 'no-token') {
    return (
      <Panel
        title="This invitation link is no longer valid"
        icon={WarningCircleIcon}
        iconColor="red"
        testId="accept-no-token"
      >
        <p>
          Open the link from the invitation email again. If it keeps landing here, ask the person
          who invited you to send a new one.
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
    <div data-testid="accept-pending" className={PANEL_SHELL_CLASSES}>
      <Spinner ariaLabel="Accepting the invitation" size={32} />
      <p className="mt-4 text-sm text-zinc-500">Accepting your invitation…</p>
    </div>
  );
}
