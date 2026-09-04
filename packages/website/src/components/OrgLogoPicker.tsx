import { useRef, useState } from 'react';
import { CameraIcon, SpinnerIcon } from '@phosphor-icons/react/dist/ssr';
import { ORG_LOGO_CONTENT_TYPES, ORG_LOGO_MAX_BYTES } from '@filone/shared';

import { OrgAvatar } from './OrgAvatar';
import { errorMessageOf, presignOrgLogoUpload } from '../lib/api.js';

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
 * whichever dialog uses it so the dialog's job is only to wire a button and
 * an input to it. Upload happens on selection, before the caller ever saves:
 * {@link presignOrgLogoUpload} hands back both the URL to PUT the file to and
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
   * Fired with the uploaded URL once the PUT lands, before this hook's own
   * `logoUrl` state even updates. Edit organization's Identity section uses
   * this to persist the change immediately (there is no Save button once the
   * name field autosaves too); the create-organization dialog leaves it
   * unset, since nothing exists yet to persist the logo against.
   */
  onUploaded?: (logoUrl: string) => void,
) {
  const [logoUrl, setLogoUrl] = useState<string | undefined>(initialLogoUrl);
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
      onUploaded?.(uploadedUrl);
    } catch (err) {
      setError(errorMessageOf(err, 'Failed to upload the logo'));
    } finally {
      setUploading(false);
    }
  }

  function reset(next?: string): void {
    setLogoUrl(next);
    setError(null);
    setUploading(false);
  }

  return { logoUrl, error, uploading, pick, reset };
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

/** The hidden `<input type="file">` both layouts wire to the same picker button. */
function fileInput(
  fileInputRef: React.RefObject<HTMLInputElement | null>,
  logo: ReturnType<typeof useOrgLogoUpload>,
) {
  return (
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
  );
}

export function AvatarPicker({ name, logo, disabled, layout = 'dialog' }: AvatarPickerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (layout === 'row') {
    return (
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          aria-label="Change avatar"
          className="group relative flex h-14 w-14 items-center justify-center rounded-xl focus-visible:brand-outline disabled:cursor-not-allowed"
        >
          <OrgAvatar name={name} logoUrl={logo.logoUrl} size="md" />
          <span className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/0 text-transparent transition-colors group-hover:bg-black/40 group-hover:text-white">
            {logo.uploading ? (
              <SpinnerIcon size={18} className="animate-spin" />
            ) : (
              <CameraIcon size={18} />
            )}
          </span>
        </button>
        {fileInput(fileInputRef, logo)}
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

  // `OrgAvatar` hashes its whole `name` for both the initial and the color, so
  // passing the live value reshuffled the color on every keystroke. The initial
  // is only ever the first character, so seeding it with just that keeps the
  // color stable while it's still true to what the org's real avatar will show.
  const previewSeed = (name || 'New organization').trim().charAt(0) || 'N';

  return (
    <div className="mb-5 flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled}
        aria-label="Choose avatar"
        className="group relative flex h-16 w-16 items-center justify-center rounded-xl focus-visible:brand-outline disabled:cursor-not-allowed"
      >
        <OrgAvatar name={previewSeed} logoUrl={logo.logoUrl} size="lg" />
        <span className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/0 text-transparent transition-colors group-hover:bg-black/40 group-hover:text-white">
          {logo.uploading ? (
            <SpinnerIcon size={20} className="animate-spin" />
          ) : (
            <CameraIcon size={20} />
          )}
        </span>
      </button>
      {fileInput(fileInputRef, logo)}
      <span className="text-xs text-zinc-500">Choose avatar</span>
      {logo.error && (
        <p role="alert" className="text-xs text-red-600">
          {logo.error}
        </p>
      )}
    </div>
  );
}
