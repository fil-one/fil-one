const STASH_KEY = 'filone:pendingInviteToken';

/**
 * The invitation token, from the emailed link to the accept call, without
 * passing through anything that keeps a copy.
 *
 * The link is `/invite/accept#token=…`. A fragment never leaves the browser, so
 * the token is absent from access logs, proxy logs, referrer headers, and the
 * URL capture every analytics and error reporter does by default — which a query
 * parameter would be present in. That property only holds while the fragment is
 * short-lived, so it is read and stripped before anything else on the page runs,
 * and the token lives in `sessionStorage` from then on.
 *
 * `sessionStorage` and not a React ref because the login bounce is a full
 * navigation: there is no `returnTo` plumbing in the auth flow — every login
 * lands on `/dashboard` — so a caller who was signed out has to leave the page
 * and come back, exactly as the step-up stash beside this one arranges.
 */

/**
 * Take the token out of the URL fragment and strip the fragment.
 *
 * The strip happens whether or not a token was found: a fragment that did not
 * parse is still a fragment somebody pasted, and it is not this page's to keep.
 *
 * @returns the token, or null when the fragment carried none.
 */
export function readAndStripInviteTokenFromHash(): string | null {
  const hash = window.location.hash;
  if (hash.length < 2) return null;

  const token = new URLSearchParams(hash.slice(1)).get('token')?.trim();

  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, '', `${pathname}${search}`);

  return token ? token : null;
}

export function stashInviteToken(token: string): void {
  try {
    sessionStorage.setItem(STASH_KEY, token);
  } catch {
    // Storage disabled. The token is still in memory for this page load, so an
    // accept that needs no login round trip still works; one that does will
    // land on the dashboard instead, and the emailed link still works.
  }
}

/**
 * Whether a token is waiting to be redeemed.
 *
 * Reads storage rather than the memo below, so that a token already taken does
 * not send the app back to the accept page again — which is what the app route
 * asks this question for.
 */
export function hasPendingInviteToken(): boolean {
  try {
    return sessionStorage.getItem(STASH_KEY) !== null;
  } catch {
    return false;
  }
}

let taken: string | null = null;

/**
 * Take the stashed token, clearing it from storage.
 *
 * Idempotent for the life of the page: the route takes it in `beforeLoad`, so
 * that storage is clear before any redirect can be thrown, and the component
 * asks again when it renders. Memoizing the answer means those two are the same
 * token rather than a token and a null, and clearing storage first means a page
 * that then fails to render cannot leave the app bouncing back here forever.
 */
export function takeInviteToken(): string | null {
  if (taken !== null) return taken;
  try {
    const stored = sessionStorage.getItem(STASH_KEY);
    if (stored !== null) sessionStorage.removeItem(STASH_KEY);
    taken = stored;
    return stored;
  } catch {
    return null;
  }
}

/** Test seam: forget the token this page load has already taken. */
export function resetTakenInviteToken(): void {
  taken = null;
}
