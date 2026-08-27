import { useEffect, useRef, useState } from 'react';
import { PaperPlaneTiltIcon } from '@phosphor-icons/react/dist/ssr';
import { CreateInvitationSchema, OrgRole } from '@filone/shared';
import type { CreateInvitationRequest } from '@filone/shared';

import { Alert } from './Alert';
import { Button } from './Button';
import { FormField } from './FormField';
import { Input } from './Input';
import { ModalBody, ModalFooter } from './Modal';
import { RadioOption } from './RadioOption';
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '../lib/use-member-scope.js';

export type InviteMemberFormProps = {
  /** The roles this caller may invite — their ceiling, as a list. */
  roles: readonly OrgRole[];
  /**
   * Awaited: the address is cleared when the invitation lands and kept when it
   * does not, so a refusal leaves the operator the thing they typed.
   */
  onSubmit: (body: CreateInvitationRequest) => void | Promise<unknown>;
  submitting?: boolean;
  /** A refusal worth keeping in the dialog, beside the controls that caused it. */
  errorMessage?: string | null;
  /** Close the dialog without sending. */
  onCancel: () => void;
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
  errorMessage,
  onCancel,
}: InviteMemberFormProps) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>(defaultRole(roles));
  const [emailError, setEmailError] = useState<string | null>(null);
  const emailField = useRef<HTMLElement>(null);

  // The ceiling can shrink under a form that is already open: an Owner who
  // demotes themselves on this same page loses Owner from `roles` while `role`
  // still holds it, and `RoleSelect` renders an out-of-ceiling value as an extra
  // option — so the form would look valid and the server would answer 403. Read
  // the role through the current list rather than trusting the state that was
  // seeded from an older one.
  const effectiveRole = roles.includes(role) ? role : defaultRole(roles);

  // Reading through the list settles this render. The state behind it still
  // holds the role the ceiling dropped, so a list that widens again — a
  // re-promotion, or a second org answering for the same mounted form — puts
  // that role back in the picker, in the sentence under it, and in the body,
  // with nobody having chosen it. Drop it instead, the way
  // `AccessKeyPermissionsFields` prunes a selection its role no longer grants.
  // No dependency list, for the same reason it has none there: the caller
  // rebuilds `roles` on every render, so the comparison above is the guard, and
  // the value it settles on is always in the list, so this runs once. An empty
  // list is a ceiling nobody has answered for yet rather than a narrower one,
  // and resetting on it would spend the operator's choice on a `/me` still in
  // flight.
  useEffect(() => {
    if (roles.length > 0 && effectiveRole !== role) setRole(effectiveRole);
  });

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = CreateInvitationSchema.safeParse({ email, role: effectiveRole });
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
      // Rendered by the caller — as an alert in this dialog for the refusals
      // worth keeping, a toast for the rest. The address stays put: a refusal
      // on an emptied field leaves nothing to try again with.
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
      className="flex flex-col"
      data-testid="invite-form"
    >
      <ModalBody>
        <div className="flex flex-col gap-4">
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

          {/* Every assignable role listed with what it grants, rather than a
              select whose description only appears once a role is chosen: the
              choice is between four things a person is comparing, and a picker
              shows one at a time. A `fieldset` because these are one question,
              not four controls — the legend names it for anybody who reaches
              the group by keyboard. */}
          <fieldset className="flex flex-col gap-2.5">
            <legend className="mb-2.5 text-xs font-medium text-zinc-900">Role</legend>
            {roles.map((role) => (
              <RadioOption
                key={role}
                name="invite-role"
                value={role}
                checked={role === effectiveRole}
                onChange={() => setRole(role)}
                description={ROLE_DESCRIPTIONS[role]}
              >
                {ROLE_LABELS[role]}
              </RadioOption>
            ))}
          </fieldset>

          {errorMessage && (
            <div data-testid="invite-error">
              <Alert variant="red" description={errorMessage} />
            </div>
          )}

          <p className="text-xs text-zinc-500">
            The invitation link can only be used once, and expires in 14 days.
          </p>
        </div>
      </ModalBody>

      <ModalFooter fullWidth>
        <Button type="button" variant="ghost" size="md" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button
          id="invite-submit-button"
          type="submit"
          variant="primary"
          size="md"
          icon={PaperPlaneTiltIcon}
          disabled={submitting || email.trim().length === 0}
        >
          {submitting ? 'Sending...' : 'Send invitation'}
        </Button>
      </ModalFooter>
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
