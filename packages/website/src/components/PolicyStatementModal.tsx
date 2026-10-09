import { useLayoutEffect, useState } from 'react';
import type { PolicyStatement } from '@filone/shared';
import {
  POLICY_SID_MAX_LENGTH,
  POLICY_WILDCARD_PRINCIPAL,
  ROSTER_SID_LABELS,
  isRosterSid,
} from '@filone/shared';

import { Alert } from './Alert.js';
import { Button } from './Button.js';
import { FormField } from './FormField.js';
import { Input } from './Input.js';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal/index.js';
import { PolicyActionFields } from './PolicyActionFields.js';
import { PolicyPrincipalFields } from './PolicyPrincipalFields.js';
import { RadioOption } from './RadioOption.js';

export type PolicyStatementModalProps = {
  open: boolean;
  onClose: () => void;
  /** The statement being edited; absent when adding one. */
  initial?: PolicyStatement;
  onSubmit: (statement: PolicyStatement) => void;
};

const EMPTY: PolicyStatement = { Effect: 'Allow', Principal: [], Action: [] };

/**
 * The refusal a typed name earns. A roster statement's own fixed name earns
 * none; any other statement may not take a roster sid, or the next role change
 * would replace it.
 */
function reservedNameError(statement: PolicyStatement, rosterLabel: string | undefined) {
  if (rosterLabel || !isRosterSid(statement.Sid?.trim())) return undefined;
  return 'This name is reserved for a statement Fil One writes.';
}

/**
 * A name of their own, or none. The schema is strict and takes `sid` only as a
 * non-empty string, so a name that is empty or all spaces drops the key rather
 * than sending one the backend refuses. Held untrimmed while it is being typed,
 * since trimming each keystroke would swallow the space between two words.
 */
function withSid(statement: PolicyStatement, name: string): PolicyStatement {
  const { Sid: _dropped, ...rest } = statement;
  return name.trim() ? { ...rest, Sid: name } : rest;
}

/**
 * The label a roster statement shows in place of its sid. That sid is how the
 * fan-out finds the statement again, so its name is fixed.
 */
function rosterLabelOf(initial: PolicyStatement | undefined): string | undefined {
  return initial?.Sid ? ROSTER_SID_LABELS[initial.Sid] : undefined;
}

/** Whether a deny names everyone, which locks the org out of the bucket until an Owner edits it. */
export function deniesEveryone(statement: Pick<PolicyStatement, 'Effect' | 'Principal'>): boolean {
  return statement.Effect === 'Deny' && statement.Principal === POLICY_WILDCARD_PRINCIPAL;
}

/**
 * Add or edit one statement. The result goes to the tab's draft; nothing is
 * written until the policy is saved as a whole.
 */
export function PolicyStatementModal({
  open,
  onClose,
  initial,
  onSubmit,
}: PolicyStatementModalProps) {
  const [statement, setStatement] = useState<PolicyStatement>(initial ?? EMPTY);
  // Re-seed each time the modal opens, so a cancelled edit leaves no trace.
  // A layout effect, so it lands before the action fields' effect prunes what
  // the caller may not hold; run after it, the re-seed would put the pruned
  // action back into a draft that no longer shows it.
  useLayoutEffect(() => {
    if (open) setStatement(initial ?? EMPTY);
  }, [open, initial]);

  const rosterLabel = rosterLabelOf(initial);
  const noPrincipal =
    statement.Principal !== POLICY_WILDCARD_PRINCIPAL && statement.Principal.length === 0;
  const noAction = statement.Action.length === 0;
  const nameError = reservedNameError(statement, rosterLabel);
  const canSubmit = !noPrincipal && !noAction && !nameError;

  function submit() {
    onSubmit(withSid(statement, statement.Sid?.trim() ?? ''));
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} size="lg" testId="policy-statement-modal">
      <ModalHeader onClose={onClose}>{initial ? 'Edit statement' : 'Add statement'}</ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-6">
          <FormField label="Name (optional)" htmlFor="policy-statement-name" error={nameError}>
            <Input
              id="policy-statement-name"
              value={rosterLabel ?? statement.Sid ?? ''}
              disabled={Boolean(rosterLabel)}
              maxLength={POLICY_SID_MAX_LENGTH}
              placeholder="Analytics team read"
              onChange={(value) => setStatement(withSid(statement, value))}
            />
          </FormField>

          <FormField label="Effect">
            <div className="flex flex-col gap-2 sm:flex-row">
              <RadioOption
                name="policy-effect"
                value="Allow"
                testId="policy-effect-allow"
                checked={statement.Effect === 'Allow'}
                onChange={() => setStatement({ ...statement, Effect: 'Allow' })}
                description="Grant the actions below"
              >
                Allow
              </RadioOption>
              <RadioOption
                name="policy-effect"
                value="Deny"
                testId="policy-effect-deny"
                checked={statement.Effect === 'Deny'}
                onChange={() => setStatement({ ...statement, Effect: 'Deny' })}
                description="Withhold them, even if another statement grants them"
              >
                Deny
              </RadioOption>
            </div>
          </FormField>

          <FormField
            label="Who does this apply to?"
            error={noPrincipal ? 'Pick at least one member, or everyone.' : undefined}
          >
            <PolicyPrincipalFields
              value={statement.Principal}
              onChange={(principal) => setStatement({ ...statement, Principal: principal })}
            />
          </FormField>

          {deniesEveryone(statement) && (
            <div data-testid="policy-statement-denies-everyone">
              <Alert
                variant="amber"
                assertive={false}
                title="This statement denies everyone"
                description="Nobody in the organization can use this bucket while it is saved. Only an Owner can edit the policy to undo it."
              />
            </div>
          )}

          <FormField
            label="What can they do?"
            error={noAction ? 'Pick at least one action.' : undefined}
          >
            <PolicyActionFields
              value={statement.Action}
              onChange={(action) => setStatement({ ...statement, Action: action })}
            />
          </FormField>
        </div>
      </ModalBody>
      <ModalFooter>
        <div className="flex justify-end gap-2">
          <Button id="policy-statement-cancel" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            id="policy-statement-submit"
            variant="primary"
            disabled={!canSubmit}
            onClick={submit}
          >
            {initial ? 'Save statement' : 'Add statement'}
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  );
}
