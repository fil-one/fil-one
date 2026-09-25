import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { OrgNameSchema } from '@filone/shared';

import { Button } from './Button';
import { FormField } from './FormField';
import { Input } from './Input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { createOrg, errorMessageOf } from '../lib/api.js';
import { switchToOrg } from '../lib/active-org.js';
import { queryKeys } from '../lib/query-client.js';

export type CreateOrganizationDialogProps = {
  open: boolean;
  onClose: () => void;
};

/** Create an additional organization for the signed-in account. */
export function CreateOrganizationDialog({ open, onClose }: CreateOrganizationDialogProps) {
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const client = useQueryClient();

  function handleClose(): void {
    setName('');
    setNameError(null);
    onClose();
  }

  const create = useMutation({
    mutationFn: (orgName: string) => createOrg({ name: orgName }),
    onSuccess: (result) => {
      // A full org switch: the new org is not the one any loaded page's data
      // describes. It lands on get-started, since a brand-new org is empty.
      const started = switchToOrg(result.orgId, 'get-started', {
        orgName: result.orgName,
      });
      if (!started) {
        // Declined (an upload is running): the tab stays put, but the org
        // exists now, and the switcher only learns of it from a fresh `/me`.
        void client.invalidateQueries({ queryKey: queryKeys.me });
      }
      handleClose();
    },
    onError: (err) => {
      setNameError(errorMessageOf(err, 'Failed to create the organization'));
    },
  });

  function save(): void {
    const parsed = OrgNameSchema.safeParse(name);
    if (!parsed.success) {
      setNameError(parsed.error.issues[0].message);
      return;
    }
    setNameError(null);
    create.mutate(parsed.data);
  }

  const busy = create.isPending;

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : handleClose}
      size="sm"
      testId="create-organization-dialog"
    >
      <ModalHeader onClose={busy ? undefined : handleClose}>Create organization</ModalHeader>
      <ModalBody>
        <FormField
          label="Organization name"
          htmlFor="create-org-name"
          error={nameError ?? undefined}
        >
          <Input
            id="create-org-name"
            value={name}
            invalid={!!nameError}
            disabled={create.isPending}
            onChange={(value) => {
              setName(value);
              if (nameError) setNameError(null);
            }}
            placeholder="Acme"
          />
        </FormField>
      </ModalBody>
      <ModalFooter fullWidth>
        <Button variant="ghost" size="md" onClick={handleClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          id="create-org-save-button"
          variant="primary"
          size="md"
          onClick={save}
          disabled={busy || !name.trim()}
        >
          {create.isPending ? 'Creating...' : 'Create organization'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
