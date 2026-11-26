import { useSyncExternalStore } from 'react';

/**
 * Tailwind's `sm` breakpoint (40rem). For a layout that must render a control
 * in one place or the other, where hiding a second copy with `sm:hidden` would
 * leave two controls with one name in the DOM.
 */
export const BELOW_SM_QUERY = '(width < 40rem)';

/**
 * Whether the viewport matches a media query, updated as it changes.
 *
 * False where `matchMedia` is missing (jsdom), so tests render the desktop layout.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia?.(query);
      list?.addEventListener('change', onChange);
      return () => list?.removeEventListener('change', onChange);
    },
    () => window.matchMedia?.(query).matches ?? false,
  );
}
