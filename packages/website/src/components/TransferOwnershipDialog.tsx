import { useEffect, useState } from 'react';

import type { AccessKeySummary } from '@filone/shared';

import { Alert } from './Alert';
import { Button } from './Button';
import { FormField } from './FormField';
import { Input } from './Input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { Skeleton } from './Skeleton';

export type TransferOwnershipDialogProps = {
  open: boolean;
  /**
   * The caller's own access keys an Admin could not mint, which confirming
   * would revoke — a forecast, not a record. Undefined while the preview loads
   * or after it failed.
   */
  affectedKeys?: AccessKeySummary[] | undefined;
  /** The preview has not answered yet, so nothing below is the whole story. */
  previewLoading?: boolean;
  /** The preview could not be read. The transfer still revokes what it must. */
  previewError?: boolean;
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
  affectedKeys,
  previewLoading = false,
  previewError = false,
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
        description={`${memberName} becomes owner of ${orgName}. You'll move to admin, and can't take ownership back yourself.`}
      >
        Transfer ownership?
      </ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-4">
          {previewLoading && <Skeleton className="h-14 w-full" />}
          {previewError && (
            <Alert
              variant="amber"
              title="The affected keys could not be listed"
              description="The transfer still revokes every key an admin cannot hold."
              assertive={false}
            />
          )}
          {affectedKeys && affectedKeys.length > 0 && (
            <Alert
              variant="amber"
              title={
                affectedKeys.length === 1
                  ? 'One of your access keys is revoked'
                  : `${affectedKeys.length} of your access keys are revoked`
              }
              // An access key carries its own permission set, fixed when it was
              // minted, so a key an Admin could not mint cannot survive the seat
              // moving.
              description={`An admin cannot hold ${affectedKeys.map((key) => key.keyName).join(', ')}. Anything using ${affectedKeys.length === 1 ? 'it' : 'them'} stops working straight away.`}
              assertive={false}
            />
          )}
          <FormField
            label={`Type ${orgName} to confirm`}
            htmlFor="transfer-confirm-name"
            description="This action cannot be undone."
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
          // Held until the preview answers: a dialog added to disclose what a
          // transfer revokes must not be confirmable before it has.
          disabled={pending || !confirmed || previewLoading}
        >
          {pending ? 'Transferring...' : 'Transfer ownership'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
