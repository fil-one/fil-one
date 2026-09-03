import { useEffect, useState } from 'react';
import clsx from 'clsx';

import { hashToPaletteIndex } from '../lib/color-from-string.js';

export type OrgAvatarSize = 'sm' | 'lg';

type OrgAvatarProps = {
  /** The org's name (or its in-progress name, before it has an id). Used both for the initial and, hashed, for the color — stable across renders without storing a color anywhere. */
  name: string;
  /** Real logo, once uploaded. Falls back to the monogram when absent or broken. */
  logoUrl?: string;
  /** `sm` (default) matches `UserAvatar`'s size, for the sidebar. `lg` is the create-organization dialog's picker. */
  size?: OrgAvatarSize;
  className?: string;
};

const SIZE_CLASSES: Record<OrgAvatarSize, string> = {
  sm: 'h-7 w-7 text-xs',
  lg: 'h-16 w-16 text-lg',
};

/**
 * Same palette `IconBox` already uses (brand/green/amber/red), plus zinc, so a
 * random org color never introduces a token nothing else in the console uses.
 * Solid backgrounds with white text, not the light tint `IconBox` uses,
 * because this avatar has to hold its own next to `UserAvatar`'s `bg-brand-600`.
 */
const PALETTE = ['bg-brand-600', 'bg-green-600', 'bg-amber-600', 'bg-red-600', 'bg-zinc-700'];

/**
 * Circular org identity, mirroring `UserAvatar`'s image-with-initial-fallback
 * shape but colored by a hash of the name rather than always `bg-brand-600` —
 * the tint is what tells two orgs' avatars apart before either has a logo.
 */
export function OrgAvatar({ name, logoUrl, size = 'sm', className }: OrgAvatarProps) {
  const [status, setStatus] = useState<'pending' | 'loaded' | 'failed'>('pending');

  useEffect(() => setStatus('pending'), [logoUrl]);

  const showImage = !!logoUrl && status !== 'failed';
  const initial = (name.trim().charAt(0) || '?').toUpperCase();
  const color = PALETTE[hashToPaletteIndex(name || 'untitled', PALETTE.length)];

  return (
    <span
      aria-hidden="true"
      className={clsx(
        'relative flex flex-shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-white',
        SIZE_CLASSES[size],
        color,
        className,
      )}
    >
      {status !== 'loaded' && initial}
      {showImage && (
        <img
          src={logoUrl}
          alt=""
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('failed')}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </span>
  );
}
