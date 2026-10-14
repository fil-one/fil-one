import { useLayoutEffect, useState } from 'react';
import type { PolicyStatement } from '@filone/shared';
import { POLICY_SID_MAX_LENGTH, POLICY_WILDCARD_PRINCIPAL } from '@filone/shared';

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

const EMPTY_STATEMENT: PolicyStatement = { Effect: 'Allow', Principal: [], Action: [] };

/**
 * Sets the statement's Sid, or removes it when the name is empty or only
 * spaces, since the schema accepts only a non-empty Sid. The name is kept
 * untrimmed while it is typed, so a space between two words is not lost.
 */
function replaceSid(statement: PolicyStatement, name: string): PolicyStatement {
  const { Sid: _dropped, ...rest } = statement;
  return name.trim() ? { ...rest, Sid: name } : rest;
}

/** Whether a deny names everyone, which locks the org out of the bucket until an Owner edits it. */
export function isDenyForEveryone(
  statement: Pick<PolicyStatement, 'Effect' | 'Principal'>,
): boolean {
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
  const [statement, setStatement] = useState<PolicyStatement>(initial ?? EMPTY_STATEMENT);
  // Reset the draft each time the modal opens, in a layout effect so it runs
  // before the action fields' effect removes actions the caller cannot grant.
  useLayoutEffect(() => {
    if (open) setStatement(initial ?? EMPTY_STATEMENT);
  }, [open, initial]);

  const hasNoPrincipal =
    statement.Principal !== POLICY_WILDCARD_PRINCIPAL && statement.Principal.length === 0;
  const hasNoAction = statement.Action.length === 0;
  const canSubmit = !hasNoPrincipal && !hasNoAction;

  function submit() {
    onSubmit(replaceSid(statement, statement.Sid?.trim() ?? ''));
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
              value={statement.Sid ?? ''}
              maxLength={POLICY_SID_MAX_LENGTH}
              placeholder="Analytics team read"
              onChange={(value) => setStatement(replaceSid(statement, value))}
            />
          </FormField>

          <FormField label="Effect">
            <div className="flex flex-col gap-2 sm:flex-row">
              <RadioOption
                name="policy-effect"
                value="Allow"
                checked={statement.Effect === 'Allow'}
                onChange={() => setStatement({ ...statement, Effect: 'Allow' })}
                description="Grant the actions below"
              >
                Allow
              </RadioOption>
              <RadioOption
                name="policy-effect"
                value="Deny"
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
            error={hasNoPrincipal ? 'Pick at least one member, or everyone.' : undefined}
          >
            <PolicyPrincipalFields
              value={statement.Principal}
              onChange={(principal) => setStatement({ ...statement, Principal: principal })}
            />
          </FormField>

          {isDenyForEveryone(statement) && (
            <Alert
              variant="amber"
              assertive={false}
              title="This statement denies everyone"
              description="Nobody in the organization can use this bucket while it is saved. Only an Owner can edit the policy to undo it."
            />
          )}

          <FormField
            label="What can they do?"
            error={hasNoAction ? 'Pick at least one action.' : undefined}
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
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canSubmit} onClick={submit}>
            {initial ? 'Save statement' : 'Add statement'}
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  );
}
