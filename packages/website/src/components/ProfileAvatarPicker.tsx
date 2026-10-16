import {
  AVATAR_CONTENT_TYPES,
  AVATAR_MAX_BYTES,
  getProvider,
  isSocialConnection,
} from '@filone/shared';
import type { MeResponse } from '@filone/shared';

import { Link } from './Link';
import { UserAvatar } from './UserAvatar.js';
import { AvatarUploadButton } from './AvatarUploadButton.js';
import { useToast } from './Toast';
import { presignAvatarUpload, updateProfile } from '../lib/api.js';
import { monogramFromName } from '../lib/monogram.js';
import { usePatchProfileCache } from '../lib/profile-cache.js';
import { useImageUpload } from '../lib/use-image-upload.js';

const ACCEPT = AVATAR_CONTENT_TYPES.join(',');
const AVATAR_MAX_MB = Math.floor(AVATAR_MAX_BYTES / (1024 * 1024));

type AvatarContentType = (typeof AVATAR_CONTENT_TYPES)[number];

/**
 * Upload then save in one step, unlike {@link useOrgLogoUpload} in
 * `OrgLogoPicker.tsx`: that one hands the uploaded URL to a dialog's own
 * "Create"/"Save" mutation, but there is no such step here - the avatar
 * autosaves the moment the file lands, the same way the name field does.
 */
function useProfileAvatarUpload() {
  const { toast } = useToast();
  const patchCache = usePatchProfileCache();
  return useImageUpload({
    contentTypes: AVATAR_CONTENT_TYPES,
    maxBytes: AVATAR_MAX_BYTES,
    noun: 'Avatar',
    presign: async (contentType) => {
      const { uploadUrl, fields, pictureUrl } = await presignAvatarUpload({
        contentType: contentType as AvatarContentType,
      });
      return { uploadUrl, fields, url: pictureUrl };
    },
    onUploaded: async (pictureUrl) => {
      const saved = await updateProfile({ pictureUrl });
      patchCache(saved);
      toast.success('Avatar updated');
    },
    errorFallback: 'Failed to update your avatar',
  });
}

/**
 * The avatar at the top of the Profile section: clickable to upload, or, for a
 * social login account, shown as the provider's picture with a pointer to
 * where it changes. The provider owns it like the name and email: Auth0
 * re-syncs it on login, so an upload here would not last (the API refuses one).
 */
export function ProfileAvatarPicker({ me }: { me: MeResponse }) {
  // Same source and helper AppShell's sidebar avatar uses, so the two always
  // show the same monogram for the same account.
  const initial = monogramFromName(me.name || me.email || 'User');

  if (isSocialConnection(me.connectionType)) {
    const provider = getProvider(me.connectionType);
    return (
      <div className="flex items-center gap-3">
        <UserAvatar src={me.picture} initial={initial} className="h-14 w-14 text-lg" />
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-medium text-zinc-900">Avatar</p>
          <p className="text-xs text-zinc-500">
            {/* A connection this build does not know by name still owns the
                picture; it is just not one there is a page to point at. */}
            {provider ? (
              <>
                Managed by {provider.label}.{' '}
                <Link
                  href={provider.profileUrl}
                  variant="accent"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Update at {provider.label}
                </Link>
              </>
            ) : (
              'Managed by your sign-in provider.'
            )}
          </p>
        </div>
      </div>
    );
  }

  return <UploadableAvatar me={me} initial={initial} />;
}

function UploadableAvatar({ me, initial }: { me: MeResponse; initial: string }) {
  const avatar = useProfileAvatarUpload();

  return (
    <div className="flex items-center gap-3">
      <AvatarUploadButton
        size="h-14 w-14"
        shape="rounded-full"
        iconSize={18}
        uploading={avatar.uploading}
        ariaLabel="Change avatar"
        accept={ACCEPT}
        onFile={(file) => void avatar.pick(file)}
        // A second pick while one uploads would race it: both saves would see
        // the same previous avatar, and the first upload would be left behind.
        disabled={avatar.uploading}
      >
        <UserAvatar src={me.picture} initial={initial} className="h-14 w-14 text-lg" />
      </AvatarUploadButton>
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
