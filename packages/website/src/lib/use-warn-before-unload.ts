/**
 * How to stop each piece of work a guard is holding. A document unload kills
 * that work on its own; an org switch is a client-side navigation that does
 * not, so it goes through {@link leaveGuardedWork}, which asks the user and
 * then stops every entry here itself.
 */
const activeGuards = new Set<{ cancel: () => void }>();

/**
 * Whether it is fine to throw away whatever a guard is protecting: true at
 * once when nothing is, otherwise the user's answer to a confirmation. When
 * the user agrees, the guarded work is cancelled before this returns, so the
 * caller can change the active org knowing nothing still running will send a
 * request under the new one.
 */
export function leaveGuardedWork(): boolean {
  if (activeGuards.size === 0) return true;
  if (!window.confirm('An upload is still running. Leave and cancel it?')) return false;
  cancelGuardedWork();
  return true;
}

/**
 * Stop every piece of guarded work without asking. For a caller that has
 * already made the work pointless: once the user has left an org, or the
 * tab's org is gone, an upload into it can only fail, and asking whether to
 * abandon it would be a question with one sensible answer.
 */
export function cancelGuardedWork(): void {
  for (const guard of [...activeGuards]) guard.cancel();
}

/**
 * Guard a piece of work until the returned release is called: closing or
 * reloading the tab asks first through `beforeunload`, and switching
 * organizations asks through {@link leaveGuardedWork}, which calls `cancel`
 * when the user agrees.
 *
 * Held by the work itself rather than by a mounted component, because an
 * upload outlives its page: the user can leave for another page in the same
 * org while it runs, and it still has to be stopped before the org changes.
 */
export function holdLeaveGuard(cancel: () => void): () => void {
  const warn = (e: BeforeUnloadEvent) => {
    e.preventDefault();
    // `preventDefault` is the current trigger; older Chromium and Safari
    // builds key the confirmation dialog off this instead.
    e.returnValue = '';
  };
  const release = () => {
    activeGuards.delete(guard);
    window.removeEventListener('beforeunload', warn);
  };
  // Released as it is cancelled, not whenever the work's own cleanup gets to
  // it: cancelled work is already on its way out, and a caller that cancels
  // and then moves the tab must not be asked about the work it just stopped.
  const guard = {
    cancel: () => {
      release();
      cancel();
    },
  };
  activeGuards.add(guard);
  window.addEventListener('beforeunload', warn);
  return release;
}
