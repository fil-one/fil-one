import { useRef } from 'react';
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
  /** The file input's `accept`. */
  accept: string;
  onFile: (file: File) => void;
  /** The avatar preview (`UserAvatar`/`OrgAvatar`) the overlay sits on top of. */
  children: React.ReactNode;
};

/**
 * An avatar preview that opens a file picker, with a camera icon (a spinner
 * while uploading) that fades in on hover.
 *
 * The overlay also shows on keyboard focus, and stays up for the whole
 * upload rather than only on hover: touch and keyboard users otherwise see
 * nothing until the upload finishes.
 */
export function AvatarUploadButton({
  size,
  shape,
  iconSize,
  uploading,
  disabled,
  ariaLabel,
  accept,
  onFile,
  children,
}: AvatarUploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-busy={uploading}
        className={clsx(
          'group relative flex items-center justify-center focus-visible:brand-outline disabled:cursor-not-allowed',
          size,
          shape,
        )}
      >
        {children}
        <span
          className={clsx(
            'absolute inset-0 flex items-center justify-center transition-colors',
            shape,
            uploading
              ? 'bg-black/40 text-white'
              : 'bg-black/0 text-transparent group-hover:bg-black/40 group-hover:text-white group-focus-visible:bg-black/40 group-focus-visible:text-white',
          )}
        >
          {uploading ? (
            <SpinnerIcon size={iconSize} className="animate-spin" />
          ) : (
            <CameraIcon size={iconSize} />
          )}
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onFile(file);
        }}
        className="hidden"
      />
    </>
  );
}
