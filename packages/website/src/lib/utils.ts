import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge knows Tailwind's own type sizes, not the console's `meta` and
 * `ui` from `globals.css`. Unregistered, `text-meta` reads to it as a colour,
 * so merging it with `text-white` dropped one of the two: an org avatar's
 * monogram lost its white and inherited the surrounding dark text. Registered,
 * they conflict only with other sizes.
 */
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ['meta', 'ui'] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
