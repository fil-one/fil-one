import { useEffect, useState } from 'react';
import clsx from 'clsx';

import { hashToPaletteIndex } from '../lib/color-from-string.js';

export type OrgAvatarSize = 'xs' | 'sm' | 'lg';

type OrgAvatarProps = {
  /** The org's name (or its in-progress name, before it has an id). Used both for the initial and, hashed, for the color — stable across renders without storing a color anywhere. */
  name: string;
  /** Real logo, once uploaded. Falls back to the monogram when absent or broken. */
  logoUrl?: string;
  /** `sm` (default) matches `UserAvatar`'s size, for the sidebar. `lg` is the create-organization dialog's picker. `xs` is for a dense list, like the org switcher's rows. */
  size?: OrgAvatarSize;
  className?: string;
};

const SIZE_CLASSES: Record<OrgAvatarSize, string> = {
  xs: 'h-4 w-4 text-[8px]',
  sm: 'h-7 w-7 text-xs',
  lg: 'h-16 w-16 text-lg',
};

// Rounded square rather than `UserAvatar`'s circle, so an org is
// distinguishable from a person at a glance and not just by color. `sm` sits
// inside the sidebar trigger's `rounded-lg` and steps down to `rounded-md` to
// nest with it; `lg` fills its `rounded-xl` button exactly (the create-org
// picker), so it matches straight across. `xs` (16px, the org switcher's
// list rows) needs a fifth step below the console's usual four —
// `rounded-md` still read closer to round than square at that size — so it's
// the one exception; DESIGN.md's radius rule is annotated accordingly.
const ROUNDED_CLASSES: Record<OrgAvatarSize, string> = {
  xs: 'rounded-sm',
  sm: 'rounded-md',
  lg: 'rounded-xl',
};

/**
 * Same palette `IconBox` already uses (brand/green/amber/red), plus zinc, so a
 * random org color never introduces a token nothing else in the console uses.
 * Solid backgrounds with white text, not the light tint `IconBox` uses,
 * because this avatar has to hold its own next to `UserAvatar`'s grey.
 */
const PALETTE = ['bg-brand-600', 'bg-green-600', 'bg-amber-600', 'bg-red-600', 'bg-zinc-700'];

/**
 * Rounded-square org identity, mirroring `UserAvatar`'s image-with-initial-
 * fallback shape but colored by a hash of the name rather than always
 * `bg-brand-600` — the tint is what tells two orgs' avatars apart before
 * either has a logo. Square (not `UserAvatar`'s circle) so an org reads as an
 * org rather than a person, the way Slack and Linear tell the two apart.
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
        'relative flex flex-shrink-0 items-center justify-center overflow-hidden font-semibold text-white',
        SIZE_CLASSES[size],
        ROUNDED_CLASSES[size],
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
