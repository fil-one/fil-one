import { useEffect } from 'react';

/**
 * Confirms before the tab closes while `active` is true — an upload in
 * flight dies with the page, and this is the one guard that covers every way
 * out: closing the tab, reloading, navigating away.
 */
export function useWarnBeforeUnload(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // `preventDefault` is the current trigger; older Chromium and Safari
      // builds key the confirmation dialog off this instead.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active]);
}
