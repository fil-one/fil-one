import { cn } from '../lib/utils.js';
import { UserAvatar } from './UserAvatar.js';

export type OrgAvatarSize = 'xs' | 'sm' | 'md' | 'lg';

type OrgAvatarProps = {
  /** The org's name (or its in-progress name, before it has an id). Only its first letter is used, for the monogram. */
  name: string;
  /** Real logo, once uploaded. Falls back to the monogram when absent or broken. */
  logoUrl?: string;
  /** `sm` (default) matches `UserAvatar`'s size, for the sidebar. `md` matches `UserAvatar`'s own settings-page size (Edit organization's Identity picker). `lg` is the create-organization dialog's picker. `xs` is for a dense list, like the org switcher's rows. */
  size?: OrgAvatarSize;
  className?: string;
};

const SIZE_CLASSES: Record<OrgAvatarSize, string> = {
  xs: 'h-4 w-4 text-[8px]',
  sm: 'h-7 w-7 text-xs',
  md: 'h-14 w-14 text-lg',
  lg: 'h-16 w-16 text-lg',
};

// Rounded square rather than `UserAvatar`'s circle, so an org is
// distinguishable from a person at a glance and not just by color. `sm` sits
// inside the sidebar trigger's `rounded-lg` and steps down to `rounded-md` to
// nest with it; `md` and `lg` both fill a `rounded-xl` button exactly (the
// Edit organization picker and the create-org picker, respectively), so they
// match straight across. `xs` (16px, the org switcher's list rows) needs a
// fifth step below the console's usual four — `rounded-md` still read closer
// to round than square at that size — so it's the one exception; DESIGN.md's
// radius rule is annotated accordingly.
const ROUNDED_CLASSES: Record<OrgAvatarSize, string> = {
  xs: 'rounded-sm',
  sm: 'rounded-md',
  md: 'rounded-xl',
  lg: 'rounded-xl',
};

/**
 * Rounded-square org identity: `UserAvatar` with a square shape, so an org
 * reads as an org rather than a person. One dark-grey background for every org.
 */
export function OrgAvatar({ name, logoUrl, size = 'sm', className }: OrgAvatarProps) {
  return (
    <UserAvatar
      src={logoUrl}
      initial={(name.trim().charAt(0) || '?').toUpperCase()}
      className={cn('bg-zinc-700 text-white', SIZE_CLASSES[size], ROUNDED_CLASSES[size], className)}
    />
  );
}
