import { useRef, useState } from 'react';
import { PaperPlaneTiltIcon } from '@phosphor-icons/react/dist/ssr';
import { CreateInvitationSchema, OrgRole } from '@filone/shared';
import type { CreateInvitationRequest } from '@filone/shared';

import { Alert } from './Alert';
import { Button } from './Button';
import { FormField } from './FormField';
import { Input } from './Input';
import { RoleSelect } from './RoleSelect';
import { ROLE_DESCRIPTIONS } from '../lib/use-member-scope.js';

export type InviteMemberFormProps = {
  /** The roles this caller may invite — their ceiling, as a list. */
  roles: readonly OrgRole[];
  /**
   * Awaited: the address is cleared when the invitation lands and kept when it
   * does not, so a refusal leaves the operator the thing they typed.
   */
  onSubmit: (body: CreateInvitationRequest) => void | Promise<unknown>;
  submitting?: boolean;
  /**
   * The invite beta has not been switched on for this org. The server's own
   * sentence, rendered in place of the form: nothing here would work, so the
   * controls go rather than sit there collecting a refusal.
   */
  notEnabledMessage?: string | null;
  /** A refusal worth keeping on screen — the pending cap, most often. */
  errorMessage?: string | null;
  /**
   * An invitation that was created but whose email did not go out. The row and
   * its token are committed before the mail is sent, so this is a live
   * invitation nobody has heard about.
   */
  undeliveredEmail?: string | null;
};

/**
 * Invite one address at a role the caller may hand out.
 *
 * Re-inviting an address that already has a live invitation is the designed
 * retry rather than an error: the server revokes the old row and replaces it,
 * taking no second slot against the org's pending cap. So the form always
 * submits and never asks whether the address is already on the list.
 */
export function InviteMemberForm({
  roles,
  onSubmit,
  submitting = false,
  notEnabledMessage,
  errorMessage,
  undeliveredEmail,
}: InviteMemberFormProps) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>(defaultRole(roles));
  const [emailError, setEmailError] = useState<string | null>(null);
  const emailField = useRef<HTMLElement>(null);

  if (notEnabledMessage) {
    return (
      <div data-testid="invite-not-enabled">
        <Alert
          variant="grey"
          title="Invitations are not enabled yet"
          description={notEnabledMessage}
        />
      </div>
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = CreateInvitationSchema.safeParse({ email, role });
    if (!parsed.success) {
      setEmailError(parsed.error.issues[0].message);
      // Submitting moved focus to the button, and the message is about the
      // field. Sending focus back is what makes it findable at all for anybody
      // not reading the page by eye.
      emailField.current?.focus();
      return;
    }
    setEmailError(null);
    try {
      await onSubmit(parsed.data);
      setEmail('');
    } catch {
      // Rendered by the caller — as an alert on this form for the refusals
      // worth keeping, a toast for the rest. The address stays put: a 409 on an
      // emptied field leaves nothing to try again with.
    }
  }

  return (
    // `noValidate` with `type="email"` on the input: the type still gets a
    // mobile keyboard the right shape, and the schema still decides what a valid
    // address is. Native validation would pre-empt it with a browser bubble
    // carrying different wording, in a different place, for the same field.
    <form
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      className="flex flex-col gap-4"
      data-testid="invite-form"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex-1">
          <FormField label="Email address" htmlFor="invite-email" error={emailError ?? undefined}>
            <Input
              id="invite-email"
              ref={emailField}
              type="email"
              value={email}
              invalid={!!emailError}
              onChange={(value) => {
                setEmail(value);
                if (emailError) setEmailError(null);
              }}
              placeholder="teammate@example.com"
              autoComplete="off"
            />
          </FormField>
        </div>
        <div className="sm:w-56">
          <FormField label="Role" htmlFor="invite-role" description={ROLE_DESCRIPTIONS[role]}>
            <RoleSelect id="invite-role" value={role} roles={roles} onChange={setRole} />
          </FormField>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button
          id="invite-submit-button"
          type="submit"
          variant="primary"
          icon={PaperPlaneTiltIcon}
          disabled={submitting || email.trim().length === 0}
        >
          {submitting ? 'Sending...' : 'Send invitation'}
        </Button>
        <p className="text-xs text-zinc-500">
          The link in the email works once, for that address, for 14 days.
        </p>
      </div>

      {undeliveredEmail && (
        <div data-testid="invite-undelivered">
          <Alert
            variant="amber"
            title="Invitation created, but the email did not go out"
            // There is no link to hand over: the token lives in the email and
            // nowhere else, so the only retry is another invitation, which
            // replaces this one rather than adding a second.
            description={`Nobody has heard about the invitation for ${undeliveredEmail}. Send it again to have another go at delivering it.`}
          />
        </div>
      )}

      {errorMessage && (
        <div data-testid="invite-error">
          <Alert variant="red" description={errorMessage} />
        </div>
      )}
    </form>
  );
}

/**
 * Member unless the caller cannot hand it out, which cannot happen today —
 * `members.manage` reaches Admin and below — but a default read out of the list
 * cannot go stale the way a hardcoded one can.
 */
function defaultRole(roles: readonly OrgRole[]): OrgRole {
  return roles.includes(OrgRole.Member) ? OrgRole.Member : (roles[0] ?? OrgRole.Member);
}
