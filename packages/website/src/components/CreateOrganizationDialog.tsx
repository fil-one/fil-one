import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { OrgNameSchema } from '@filone/shared';

import { AvatarPicker, useOrgLogoUpload } from './OrgLogoPicker.js';
import { Button } from './Button';
import { FormField } from './FormField';
import { Input } from './Input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { createOrg, errorMessageOf } from '../lib/api.js';
import { switchToOrg } from '../lib/active-org.js';

export type CreateOrganizationDialogProps = {
  open: boolean;
  onClose: () => void;
};

/**
 * Create an additional organization for the signed-in account.
 *
 * The avatar defaults to a generated monogram (live, from whatever name is
 * typed — same idea `WelcomePage` deliberately left out of the naming step
 * until there was an upload behind it; there is now) and becomes the real
 * logo once one is uploaded, via {@link AvatarPicker}/{@link useOrgLogoUpload}.
 */
export function CreateOrganizationDialog({ open, onClose }: CreateOrganizationDialogProps) {
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const logo = useOrgLogoUpload();

  function handleClose(): void {
    setName('');
    setNameError(null);
    logo.reset();
    onClose();
  }

  const create = useMutation({
    mutationFn: () => createOrg({ name: OrgNameSchema.parse(name), logoUrl: logo.logoUrl }),
    onSuccess: (result) => {
      // Only the account's first-ever org gets a free trial (see
      // `isSoloPersonalOrg` — this dialog is unreachable for that one, since a
      // brand-new account is named through the signup flow instead), so this
      // one lands with no active plan. `$orgSlug.tsx`'s own billing gate
      // catches that on arrival and blocks the whole org behind an "add a
      // card" page — nothing to arrange here.
      //
      // A full org switch (clears every cached query, navigates in) — the new
      // org is not the one any currently-loaded page's data describes. It lands
      // on get-started rather than the dashboard: the org is brand new and
      // empty, so those two setup tasks are what it needs, not a page of zeroes
      // — once the gate above lets it through.
      // The slug its response just carried saves the switch a second redirect.
      switchToOrg(result.orgId, result.slug, 'get-started', {
        orgName: result.orgName,
        logoUrl: result.logoUrl,
      });
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
    create.mutate();
  }

  const busy = create.isPending || logo.uploading;

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : handleClose}
      size="sm"
      testId="create-organization-dialog"
    >
      <ModalHeader onClose={busy ? undefined : handleClose}>Create organization</ModalHeader>
      <ModalBody>
        <AvatarPicker name={name} logo={logo} disabled={busy} />
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
