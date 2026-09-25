import { useEffect, useState } from 'react';
import type { PolicyStatement } from '@filone/shared';
import {
  POLICY_SID_MAX_LENGTH,
  POLICY_WILDCARD_PRINCIPAL,
  ROSTER_SID_LABELS,
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

const EMPTY: PolicyStatement = { effect: 'allow', principal: [], action: [] };

/**
 * A name of their own, or none. The schema is strict and takes `sid` only as a
 * non-empty string, so a name that is empty or all spaces drops the key rather
 * than sending one the backend refuses. Held untrimmed while it is being typed,
 * since trimming each keystroke would swallow the space between two words.
 */
function withSid(statement: PolicyStatement, name: string): PolicyStatement {
  const { sid: _dropped, ...rest } = statement;
  return name.trim() ? { ...rest, sid: name } : rest;
}

/**
 * The label a roster statement shows in place of its sid. That sid is how the
 * fan-out finds the statement again, so its name is fixed.
 */
function rosterLabelOf(initial: PolicyStatement | undefined): string | undefined {
  return initial?.sid ? ROSTER_SID_LABELS[initial.sid] : undefined;
}

/** Whether a deny names everyone, which locks the org out of the bucket until an Owner edits it. */
export function deniesEveryone(statement: Pick<PolicyStatement, 'effect' | 'principal'>): boolean {
  return statement.effect === 'deny' && statement.principal === POLICY_WILDCARD_PRINCIPAL;
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
  useEffect(() => {
    if (open) setStatement(initial ?? EMPTY);
  }, [open, initial]);

  const rosterLabel = rosterLabelOf(initial);
  const noPrincipal =
    statement.principal !== POLICY_WILDCARD_PRINCIPAL && statement.principal.length === 0;
  const noAction = statement.action.length === 0;
  const canSubmit = !noPrincipal && !noAction;

  function submit() {
    onSubmit(withSid(statement, statement.sid?.trim() ?? ''));
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} size="lg" testId="policy-statement-modal">
      <ModalHeader onClose={onClose}>{initial ? 'Edit statement' : 'Add statement'}</ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-6">
          <FormField label="Name (optional)" htmlFor="policy-statement-name">
            <Input
              id="policy-statement-name"
              value={rosterLabel ?? statement.sid ?? ''}
              disabled={Boolean(rosterLabel)}
              maxLength={POLICY_SID_MAX_LENGTH}
              placeholder="Analytics team read"
              onChange={(value) => setStatement(withSid(statement, value))}
            />
          </FormField>

          <FormField label="Effect">
            <div className="flex gap-2">
              <RadioOption
                name="policy-effect"
                value="allow"
                testId="policy-effect-allow"
                checked={statement.effect === 'allow'}
                onChange={() => setStatement({ ...statement, effect: 'allow' })}
                description="Grant the actions below"
              >
                Allow
              </RadioOption>
              <RadioOption
                name="policy-effect"
                value="deny"
                testId="policy-effect-deny"
                checked={statement.effect === 'deny'}
                onChange={() => setStatement({ ...statement, effect: 'deny' })}
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
              value={statement.principal}
              onChange={(principal) => setStatement({ ...statement, principal })}
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
              value={statement.action}
              onChange={(action) => setStatement({ ...statement, action })}
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
