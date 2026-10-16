import { useState } from 'react';
import { ORG_LOGO_CONTENT_TYPES, ORG_LOGO_MAX_BYTES } from '@filone/shared';

import { OrgAvatar } from './OrgAvatar';
import { AvatarUploadButton } from './AvatarUploadButton.js';
import { presignOrgLogoUpload } from '../lib/api.js';
import { useImageUpload } from '../lib/use-image-upload.js';

const ACCEPT = ORG_LOGO_CONTENT_TYPES.join(',');

type LogoContentType = (typeof ORG_LOGO_CONTENT_TYPES)[number];

/**
 * The logo upload's state and the presign-then-POST flow. Upload happens on
 * selection, before the caller ever saves:
 * {@link presignOrgLogoUpload} hands back both the URL to POST the file to and
 * the URL to read it back from, and the latter is what rides along in the
 * dialog's own mutation — nothing here needs the org's id.
 *
 * `initialLogoUrl` seeds the state for a dialog that already has one (Edit),
 * and stays undefined for a dialog that starts from nothing (Create).
 * `reset(next)` is how a caller resyncs after closing — Create always
 * resets to nothing, Edit resets back to the org's current logo so a
 * cancelled pick doesn't linger into the next time the dialog opens.
 */
export function useOrgLogoUpload(
  initialLogoUrl?: string,
  /**
   * Fired with the uploaded URL once the upload lands, before this hook's own
   * `logoUrl` state even updates. Edit organization's Identity section uses
   * this to persist the change immediately (there is no Save button once the
   * name field autosaves too); the create-organization dialog leaves it
   * unset, since nothing exists yet to persist the logo against.
   */
  onUploaded?: (logoUrl: string) => void,
) {
  const [logoUrl, setLogoUrl] = useState<string | undefined>(initialLogoUrl);
  const upload = useImageUpload({
    contentTypes: ORG_LOGO_CONTENT_TYPES,
    maxBytes: ORG_LOGO_MAX_BYTES,
    noun: 'Logo',
    presign: async (contentType) => {
      const {
        uploadUrl,
        fields,
        logoUrl: url,
      } = await presignOrgLogoUpload({
        contentType: contentType as LogoContentType,
      });
      return { uploadUrl, fields, url };
    },
    onUploaded: (uploadedUrl) => {
      setLogoUrl(uploadedUrl);
      onUploaded?.(uploadedUrl);
    },
    errorFallback: 'Failed to upload the logo',
  });

  function reset(next?: string): void {
    setLogoUrl(next);
    upload.reset();
  }

  return { logoUrl, error: upload.error, uploading: upload.uploading, pick: upload.pick, reset };
}

const ORG_LOGO_MAX_MB = Math.floor(ORG_LOGO_MAX_BYTES / (1024 * 1024));

type AvatarPickerProps = {
  name: string;
  logo: ReturnType<typeof useOrgLogoUpload>;
  disabled: boolean;
  /**
   * `dialog` (default): the centered tile above the name field, matching
   * Resend's "Create new team" dialog - for the create-organization flow,
   * where `name` is still being typed and there is no saved identity yet.
   * `row`: the left-aligned avatar-plus-caption row Settings' own avatar
   * picker uses, for Edit organization's Identity section, where `name` is
   * the org's already-saved name rather than a live draft.
   */
  layout?: 'dialog' | 'row';
};

export function AvatarPicker({ name, logo, disabled, layout = 'dialog' }: AvatarPickerProps) {
  const pick = (file: File) => void logo.pick(file);

  if (layout === 'row') {
    return (
      <div className="flex items-center gap-3">
        <AvatarUploadButton
          size="h-14 w-14"
          shape="rounded-xl"
          iconSize={18}
          uploading={logo.uploading}
          disabled={disabled}
          ariaLabel="Change avatar"
          accept={ACCEPT}
          onFile={pick}
        >
          <OrgAvatar name={name} logoUrl={logo.logoUrl} size="md" />
        </AvatarUploadButton>
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-medium text-zinc-900">Avatar</p>
          <p className="text-xs text-zinc-500">PNG, JPEG, or WebP. Up to {ORG_LOGO_MAX_MB}MB.</p>
          {logo.error && (
            <p role="alert" className="text-xs text-red-600">
              {logo.error}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-5 flex flex-col items-center gap-2">
      <AvatarUploadButton
        size="h-16 w-16"
        shape="rounded-xl"
        iconSize={20}
        uploading={logo.uploading}
        disabled={disabled}
        ariaLabel="Choose avatar"
        accept={ACCEPT}
        onFile={pick}
      >
        <OrgAvatar name={name.trim() || 'New organization'} logoUrl={logo.logoUrl} size="lg" />
      </AvatarUploadButton>
      <span className="text-xs text-zinc-500">Choose avatar</span>
      {logo.error && (
        <p role="alert" className="text-xs text-red-600">
          {logo.error}
        </p>
      )}
    </div>
  );
}
