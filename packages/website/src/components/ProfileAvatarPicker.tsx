import { useRef } from 'react';
import { AVATAR_CONTENT_TYPES, AVATAR_MAX_BYTES } from '@filone/shared';
import type { MeResponse } from '@filone/shared';

import { UserAvatar } from './UserAvatar.js';
import { AvatarUploadButton } from './AvatarUploadButton.js';
import { useToast } from './Toast';
import { presignAvatarUpload, updateProfile } from '../lib/api.js';
import { monogramFromName } from '../lib/monogram.js';
import { usePatchProfileCache } from '../lib/profile-cache.js';
import { useImageUpload, validateImageFile } from '../lib/use-image-upload.js';

const ACCEPT = AVATAR_CONTENT_TYPES.join(',');
const AVATAR_MAX_MB = Math.floor(AVATAR_MAX_BYTES / (1024 * 1024));

type AvatarContentType = (typeof AVATAR_CONTENT_TYPES)[number];

/**
 * Upload then save in one step, unlike {@link useOrgLogoUpload} in
 * `OrgLogoPicker.tsx`: that one hands the uploaded URL to a dialog's own
 * "Create"/"Save" mutation, but there is no such step here - the avatar
 * autosaves the moment the file lands, the same way the name field does.
 */
function useProfileAvatarUpload(me: MeResponse) {
  const { toast } = useToast();
  const patchCache = usePatchProfileCache();
  const upload = useImageUpload<string>({
    validate: (file) =>
      validateImageFile(file, {
        contentTypes: AVATAR_CONTENT_TYPES,
        maxBytes: AVATAR_MAX_BYTES,
        noun: 'Avatar',
      }),
    presign: async (contentType) => {
      const { uploadUrl, pictureUrl } = await presignAvatarUpload({
        contentType: contentType as AvatarContentType,
      });
      return { uploadUrl, result: pictureUrl };
    },
    onUploaded: async (pictureUrl) => {
      const saved = await updateProfile({ pictureUrl });
      patchCache(saved);
      toast.success('Avatar updated');
    },
    errorFallback: 'Failed to update your avatar',
  });

  return {
    picture: me.picture,
    uploading: upload.uploading,
    error: upload.error,
    pick: upload.pick,
  };
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
      <AvatarUploadButton
        size="h-14 w-14"
        shape="rounded-full"
        iconSize={18}
        uploading={avatar.uploading}
        ariaLabel="Change avatar"
        onClick={() => fileInputRef.current?.click()}
      >
        <UserAvatar src={avatar.picture} initial={initial} className="h-14 w-14 text-lg" />
      </AvatarUploadButton>
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
        <p className="text-sm font-medium text-zinc-900">Avatar</p>
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
