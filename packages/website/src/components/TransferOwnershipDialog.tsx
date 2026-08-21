import { useEffect, useState } from 'react';

import { Button } from './Button';
import { FormField } from './FormField';
import { Input } from './Input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';

export type TransferOwnershipDialogProps = {
  open: boolean;
  /** The organization changing hands, and the word the caller has to type. */
  orgName: string;
  /** Who is receiving it, named as the roster names them. */
  memberName: string;
  pending?: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

/**
 * Hand the Owner seat to another member.
 *
 * The only console action that takes away the caller's own authority, and the
 * only one with no undo they hold themselves: afterwards the new Owner decides
 * whether it comes back. So the confirmation is deliberately slow — the facts
 * are stated first, and the button stays inert until the organization's name is
 * typed out. A click-through dialog is the wrong shape for a change nobody can
 * reverse on their own.
 *
 * The server asks for more than this: the transfer is the one org route behind a
 * step-up, so a caller whose session is not freshly authenticated goes through
 * Auth0 and comes back to this dialog.
 */
export function TransferOwnershipDialog({
  open,
  orgName,
  memberName,
  pending = false,
  onClose,
  onConfirm,
}: TransferOwnershipDialogProps) {
  const [typed, setTyped] = useState('');

  // A dialog reopened for somebody else starts empty. It is also what clears the
  // field after a step-up round trip brings the caller back to it.
  useEffect(() => {
    if (open) setTyped('');
  }, [open, memberName]);

  const confirmed = typed.trim().toLowerCase() === orgName.trim().toLowerCase();

  return (
    <Modal open={open} onClose={pending ? () => {} : onClose} size="sm" testId="transfer-dialog">
      <ModalHeader
        onClose={pending ? undefined : onClose}
        description={`${memberName} becomes an owner of ${orgName}, and you become an admin.`}
      >
        Transfer ownership?
      </ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-4">
          <p className="text-sm leading-relaxed text-(--color-paragraph-text)">
            You give up your owner role. After this, {memberName} manages billing, every member, and
            the organization itself — including whether you keep your admin role. You cannot take
            ownership back on your own.
          </p>
          <FormField
            label={`Type ${orgName} to confirm`}
            htmlFor="transfer-confirm-name"
            description="This is the slow part on purpose."
          >
            <Input
              id="transfer-confirm-name"
              value={typed}
              onChange={setTyped}
              placeholder={orgName}
              autoComplete="off"
              disabled={pending}
            />
          </FormField>
        </div>
      </ModalBody>
      <ModalFooter fullWidth>
        <Button
          id="transfer-cancel-button"
          variant="ghost"
          size="md"
          onClick={onClose}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button
          id="transfer-confirm-button"
          variant="destructive"
          size="md"
          onClick={onConfirm}
          disabled={pending || !confirmed}
        >
          {pending ? 'Transferring...' : 'Transfer ownership'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
