const ACTIVE_ORG_KEY = 'filone:activeOrgId';
const RECONCILED_KEY = 'filone:activeOrgReconciled';

/**
 * Which organization this tab is operating in.
 *
 * `sessionStorage`, per tab, like the step-up stash beside it. A shared
 * `localStorage` value would let a switch in one tab silently retarget another
 * tab's requests, and a destructive click in the stale tab would land in the
 * wrong org. Per-tab isolation is an implementation property rather than a
 * product commitment: org-scoped sessions fix org context per browser session
 * later, and nothing here promises multi-org tabs.
 *
 * Absent means "the org my identity says is mine" — the server resolves it that
 * way when the header is missing, so a first visit needs no stash to work.
 *
 * Every accessor tolerates storage being unavailable (private mode, storage
 * disabled). The failure mode is then the personal org on every request, which
 * is the same thing a caller with no stash gets.
 */
export function getActiveOrgId(): string | null {
  try {
    return sessionStorage.getItem(ACTIVE_ORG_KEY);
  } catch {
    return null;
  }
}

export function setActiveOrgId(orgId: string): void {
  try {
    sessionStorage.setItem(ACTIVE_ORG_KEY, orgId);
  } catch {
    // Storage disabled — the tab keeps operating in the caller's own org.
  }
}

export function clearActiveOrgId(): void {
  try {
    sessionStorage.removeItem(ACTIVE_ORG_KEY);
  } catch {
    // Storage disabled, so there was nothing stored to clear.
  }
}

let switching = false;

/**
 * How long the tab waits for a navigation it asked for before deciding it is not
 * coming. Long enough that a slow load is never mistaken for a cancelled one,
 * short enough that a user who chose to stay is not left with an inert page.
 */
const NAVIGATION_GIVE_UP_MS = 4000;

/** Told the latch went up or came down, so React can re-render the switcher. */
const switchingListeners = new Set<(switching: boolean) => void>();

/**
 * Whether this tab is between orgs.
 *
 * `switchToOrg` and `reconcileActiveOrg` both navigate, and a browser takes its
 * time about it: requests started in that window carry the new stash value while
 * the page still shows the old org, and their answers are discarded by the
 * navigation anyway. `apiRequest` holds them instead, and the switcher disables
 * its buttons, so nothing is issued against an org the user has already left.
 */
export function isSwitchingOrg(): boolean {
  return switching;
}

/** Subscribe to the latch. Returns the unsubscribe. */
export function onSwitchingOrgChange(listener: (switching: boolean) => void): () => void {
  switchingListeners.add(listener);
  return () => switchingListeners.delete(listener);
}

function setSwitching(next: boolean): void {
  switching = next;
  for (const listener of switchingListeners) listener(next);
}

/**
 * Raise the latch, and take it down again if the navigation never happens.
 *
 * A `beforeunload` handler can cancel it — the upload page installs one while a
 * transfer is running, and a user who answers "stay on this page" leaves a tab
 * that asked to switch and did not. Without a way back, `apiRequest` holds every
 * request forever and the switcher's rows stay inert: the console looks alive
 * and does nothing.
 *
 * `pagehide` fires when the page really is going, and cancels the rollback. What
 * is left is the cancelled case, where the prior stash goes back so the tab
 * keeps working in the org still on screen.
 */
function latchUntilNavigation(previousOrgId: string | null): void {
  setSwitching(true);

  const rollback = setTimeout(() => {
    window.removeEventListener('pagehide', cancel);
    if (previousOrgId === null) clearActiveOrgId();
    else setActiveOrgId(previousOrgId);
    console.warn('[active-org] The org switch never navigated — staying in the current org');
    setSwitching(false);
  }, NAVIGATION_GIVE_UP_MS);

  function cancel(): void {
    clearTimeout(rollback);
    window.removeEventListener('pagehide', cancel);
  }
  window.addEventListener('pagehide', cancel);
}

/**
 * Switch this tab to another org: stash the choice and load the console's root.
 *
 * A full page load rather than query invalidation. No query key carries an org
 * dimension, and `/me` is cached under two keys with a ten-minute stale time, so
 * a load is the one mechanism that cannot leak org A's cache into org B's view.
 * A soft switch — org id in every key — is later polish.
 *
 * The root rather than the current URL: bucket names, key ids and every other
 * path segment are org-scoped, so reloading in place would greet the user with a
 * not-found page in the org they just chose.
 */
export function switchToOrg(orgId: string): void {
  const previousOrgId = getActiveOrgId();
  setActiveOrgId(orgId);
  latchUntilNavigation(previousOrgId);
  window.location.assign('/');
}

/**
 * Check the org the server resolved against the one this tab asked for, and
 * recover when they disagree.
 *
 * `GET /api/me` echoes the active org it actually served. A mismatch means the
 * stash is wrong — the caller was removed from that org, the org was deleted, or
 * a proxy dropped the header — and every request this tab makes is landing
 * somewhere the user did not choose. Clearing the stash and reloading is the
 * recovery: the next load sends no header, the server answers under the caller's
 * own org, and there is nothing left to mismatch, so this cannot loop.
 *
 * The reload is silent unless something says so, and a persistently stripped
 * header makes every switcher click land back on the personal org — which looks
 * exactly like a switch that did nothing. A flag survives the reload and the
 * page that comes back says what happened.
 *
 * Only `/me` carries the echo, so this belongs at that call rather than in
 * `apiRequest`.
 *
 * @returns whether a reload was triggered.
 */
export function reconcileActiveOrg(resolvedOrgId: string | undefined): boolean {
  const stashed = getActiveOrgId();
  if (!stashed || !resolvedOrgId || stashed === resolvedOrgId) return false;

  console.warn('[active-org] The server resolved a different org than this tab asked for', {
    requested: stashed,
    resolved: resolvedOrgId,
  });
  clearActiveOrgId();
  noteReconcile();
  latchUntilNavigation(stashed);
  window.location.reload();
  return true;
}

/** Leave word for the page that comes back that its org changed under it. */
function noteReconcile(): void {
  try {
    sessionStorage.setItem(RECONCILED_KEY, '1');
  } catch {
    // Storage disabled — the recovery still happens, unannounced.
  }
}

/**
 * Whether the load that just happened followed a reconcile, clearing the flag so
 * the notice shows once.
 */
export function takeReconcileNotice(): boolean {
  try {
    if (sessionStorage.getItem(RECONCILED_KEY) === null) return false;
    sessionStorage.removeItem(RECONCILED_KEY);
    return true;
  } catch {
    return false;
  }
}

let stashClearedAfterRefusal = false;

/** Statuses that mean `/me` refused the header rather than failed on its own. */
const HEADER_REFUSAL_STATUSES = new Set([400, 403, 404]);

/**
 * Drop the stash after `/me` refused the org header itself.
 *
 * The echo is the ordinary way a stale stash gets cleared, and a refusal carries
 * no echo: a tab whose stashed org has become unreachable would otherwise send
 * the same header forever, including to the one endpoint whose answer could have
 * fixed it.
 *
 * Only for a status the header can be blamed for. A network failure or a 5xx
 * says nothing about the org, and the query client retries both — so clearing on
 * one sent the retry without the header, got an answer scoped to the identity-row
 * org, and left org B's data on screen with every later request, mutations
 * included, landing somewhere else. The stash survives those; a 400, 403 or 404
 * is the server declining the org and is what this exists for.
 *
 * A clear is a scope change, so the caller reloads: cached data for the org this
 * tab has just left must not outlive it.
 *
 * Once per page load. A `/me` that is refusing for its own reasons must not turn
 * into a tab that clears and retries without end.
 *
 * @returns whether a stash was cleared.
 */
export function clearActiveOrgAfterRefusal(status: number | undefined): boolean {
  if (status === undefined || !HEADER_REFUSAL_STATUSES.has(status)) return false;
  const stashed = getActiveOrgId();
  if (stashClearedAfterRefusal || !stashed) return false;
  stashClearedAfterRefusal = true;
  console.warn('[active-org] /me refused the org this tab asked for — dropping it', { status });
  clearActiveOrgId();
  noteReconcile();
  latchUntilNavigation(stashed);
  window.location.reload();
  return true;
}
