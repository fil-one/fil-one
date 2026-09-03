import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CameraIcon, SpinnerIcon } from '@phosphor-icons/react/dist/ssr';
import { ORG_LOGO_CONTENT_TYPES, ORG_LOGO_MAX_BYTES, OrgNameSchema } from '@filone/shared';

import { Button } from './Button';
import { FormField } from './FormField';
import { Input } from './Input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { OrgAvatar } from './OrgAvatar';
import { createOrg, errorMessageOf, presignOrgLogoUpload } from '../lib/api.js';
import { switchToOrg } from '../lib/active-org.js';

export type CreateOrganizationDialogProps = {
  open: boolean;
  onClose: () => void;
};

const ACCEPT = ORG_LOGO_CONTENT_TYPES.join(',');

type LogoContentType = (typeof ORG_LOGO_CONTENT_TYPES)[number];

/** `null` means the file is acceptable. */
function validateLogoFile(file: File): string | null {
  if (!ORG_LOGO_CONTENT_TYPES.includes(file.type as LogoContentType)) {
    return 'Logo must be a PNG, JPEG, or WebP image.';
  }
  if (file.size > ORG_LOGO_MAX_BYTES) {
    return `Logo must be under ${Math.floor(ORG_LOGO_MAX_BYTES / (1024 * 1024))}MB.`;
  }
  return null;
}

/**
 * The logo upload's own state and the presign-then-PUT flow, pulled out of
 * the dialog itself so the dialog's job is only to wire a button and an
 * input to it. Upload happens on selection, before the org exists:
 * {@link presignOrgLogoUpload} hands back both the URL to PUT the file to and
 * the URL to read it back from, and the latter is what rides along in
 * {@link createOrg}'s body — nothing here needs the org's id.
 */
function useOrgLogoUpload() {
  const [logoUrl, setLogoUrl] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function pick(file: File): Promise<void> {
    const validationError = validateLogoFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const { uploadUrl, logoUrl: uploadedUrl } = await presignOrgLogoUpload({
        contentType: file.type as LogoContentType,
      });
      const putResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!putResponse.ok) throw new Error('Upload failed');
      setLogoUrl(uploadedUrl);
    } catch (err) {
      setError(errorMessageOf(err, 'Failed to upload the logo'));
    } finally {
      setUploading(false);
    }
  }

  function reset(): void {
    setLogoUrl(undefined);
    setError(null);
    setUploading(false);
  }

  return { logoUrl, error, uploading, pick, reset };
}

type AvatarPickerProps = {
  name: string;
  logo: ReturnType<typeof useOrgLogoUpload>;
  disabled: boolean;
};

/** The clickable tile above the name field, matching Resend's "Create new team" dialog. */
function AvatarPicker({ name, logo, disabled }: AvatarPickerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="mb-5 flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled}
        aria-label="Choose avatar"
        className="group relative flex h-16 w-16 items-center justify-center rounded-full focus-visible:brand-outline disabled:cursor-not-allowed"
      >
        <OrgAvatar name={name || 'New organization'} logoUrl={logo.logoUrl} size="lg" />
        <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/0 text-transparent transition-colors group-hover:bg-black/40 group-hover:text-white">
          {logo.uploading ? (
            <SpinnerIcon size={20} className="animate-spin" />
          ) : (
            <CameraIcon size={20} />
          )}
        </span>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void logo.pick(file);
        }}
        className="hidden"
      />
      <span className="text-xs text-zinc-500">Choose avatar</span>
      {logo.error && (
        <p role="alert" className="text-xs text-red-600">
          {logo.error}
        </p>
      )}
    </div>
  );
}

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
      // A full org switch (clears every cached query, navigates in) — the new
      // org is not the one any currently-loaded page's data describes.
      switchToOrg(result.orgId);
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
