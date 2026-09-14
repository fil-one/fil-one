import { CameraIcon, SpinnerIcon } from '@phosphor-icons/react/dist/ssr';
import clsx from 'clsx';

type AvatarUploadButtonProps = {
  /** Tailwind size classes, e.g. `'h-14 w-14'` — matched to the avatar preview inside. */
  size: string;
  /** `rounded-full` for a personal avatar, `rounded-xl` for an org's. */
  shape: 'rounded-full' | 'rounded-xl';
  iconSize: number;
  uploading: boolean;
  disabled?: boolean;
  ariaLabel: string;
  onClick: () => void;
  /** The avatar preview (`UserAvatar`/`OrgAvatar`) the overlay sits on top of. */
  children: React.ReactNode;
};

/**
 * The hover-to-change affordance both `OrgLogoPicker` and `ProfileAvatarPicker`
 * used to render by hand: an avatar preview with a camera icon (a spinner
 * while uploading) that fades in on hover, in whichever shape and size the
 * caller's own avatar is. Pulled out once both turned out pixel-identical
 * apart from those two things.
 */
export function AvatarUploadButton({
  size,
  shape,
  iconSize,
  uploading,
  disabled,
  ariaLabel,
  onClick,
  children,
}: AvatarUploadButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={clsx(
        'group relative flex items-center justify-center focus-visible:brand-outline disabled:cursor-not-allowed',
        size,
        shape,
      )}
    >
      {children}
      <span
        className={clsx(
          'absolute inset-0 flex items-center justify-center bg-black/0 text-transparent transition-colors group-hover:bg-black/40 group-hover:text-white',
          shape,
        )}
      >
        {uploading ? (
          <SpinnerIcon size={iconSize} className="animate-spin" />
        ) : (
          <CameraIcon size={iconSize} />
        )}
      </span>
    </button>
  );
}
