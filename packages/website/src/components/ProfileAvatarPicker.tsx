import { useRef, useState } from 'react';
import { CameraIcon, SpinnerIcon } from '@phosphor-icons/react/dist/ssr';
import { AVATAR_CONTENT_TYPES, AVATAR_MAX_BYTES } from '@filone/shared';
import type { MeResponse } from '@filone/shared';

import { UserAvatar } from './UserAvatar.js';
import { useToast } from './Toast';
import { errorMessageOf, presignAvatarUpload, updateProfile } from '../lib/api.js';
import { monogramFromName } from '../lib/monogram.js';
import { usePatchProfileCache } from '../lib/profile-cache.js';

const ACCEPT = AVATAR_CONTENT_TYPES.join(',');
const AVATAR_MAX_MB = Math.floor(AVATAR_MAX_BYTES / (1024 * 1024));

type AvatarContentType = (typeof AVATAR_CONTENT_TYPES)[number];

/** `null` means the file is acceptable. */
function validateAvatarFile(file: File): string | null {
  if (!AVATAR_CONTENT_TYPES.includes(file.type as AvatarContentType)) {
    return 'Avatar must be a PNG, JPEG, or WebP image.';
  }
  if (file.size > AVATAR_MAX_BYTES) {
    return `Avatar must be under ${AVATAR_MAX_MB}MB.`;
  }
  return null;
}

/**
 * Upload then save in one step, unlike {@link useOrgLogoUpload} in
 * `OrgLogoPicker.tsx`: that one hands the uploaded URL to a dialog's own
 * "Create"/"Save" mutation, but there is no such step here - the avatar
 * autosaves the moment the file lands, the same way the name field does.
 */
function useProfileAvatarUpload(me: MeResponse) {
  const { toast } = useToast();
  const patchCache = usePatchProfileCache();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File): Promise<void> {
    const validationError = validateAvatarFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const { uploadUrl, pictureUrl } = await presignAvatarUpload({
        contentType: file.type as AvatarContentType,
      });
      const putResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!putResponse.ok) throw new Error('Upload failed');

      const saved = await updateProfile({ pictureUrl });
      patchCache(saved);
      toast.success('Avatar updated');
    } catch (err) {
      setError(errorMessageOf(err, 'Failed to update your avatar'));
    } finally {
      setUploading(false);
    }
  }

  return { picture: me.picture, uploading, error, pick };
}

/** The clickable avatar at the top of the Profile section. */
export function ProfileAvatarPicker({ me }: { me: MeResponse }) {
  const avatar = useProfileAvatarUpload(me);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Same source and helper AppShell's sidebar avatar uses, so the two always
  // show the same monogram for the same account.
  const initial = monogramFromName(me.name || me.email || 'User');

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        aria-label="Change avatar"
        className="group relative flex h-14 w-14 items-center justify-center rounded-full focus-visible:brand-outline"
      >
        <UserAvatar src={avatar.picture} initial={initial} className="h-14 w-14 text-lg" />
        <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/0 text-transparent transition-colors group-hover:bg-black/40 group-hover:text-white">
          {avatar.uploading ? (
            <SpinnerIcon size={18} className="animate-spin" />
          ) : (
            <CameraIcon size={18} />
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
          if (file) void avatar.pick(file);
        }}
        className="hidden"
      />
      <div className="flex flex-col gap-0.5">
        <p className="text-xs font-medium text-zinc-900">Avatar</p>
        <p className="text-xs text-zinc-500">PNG, JPEG, or WebP. Up to {AVATAR_MAX_MB}MB.</p>
        {avatar.error && (
          <p role="alert" className="text-xs text-red-600">
            {avatar.error}
          </p>
        )}
      </div>
    </div>
  );
}
