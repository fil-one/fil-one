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
 * Whether the last fragment read asked for sign-up (`signup=1`), which the
 * backend adds when the invited address has no account yet.
 *
 * Memory only: the accept route's `beforeLoad` runs twice on first load and
 * the second run finds the fragment gone, yet both must redirect to the same
 * place. The login redirect reloads the document, so the hint lasts exactly
 * that one redirect.
 */
let signUpHinted = false;

/**
 * Take the token, and the sign-up hint beside it, out of the URL fragment and
 * strip the fragment.
 *
 * The strip happens whether or not a token was found: a fragment that did not
 * parse is still a fragment somebody pasted, and it is not this page's to keep.
 *
 * @returns the token, or null when the fragment carried none.
 */
export function readAndStripInviteTokenFromHash(): string | null {
  const hash = window.location.hash;
  if (hash.length < 2) return null;

  const params = new URLSearchParams(hash.slice(1));
  const token = params.get('token')?.trim();
  signUpHinted = params.get('signup') === '1';

  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, '', `${pathname}${search}`);

  return token ? token : null;
}

export function hasSignUpHint(): boolean {
  return signUpHinted;
}

/**
 * The token for a document whose storage refused to hold it.
 *
 * Narrow, and worth the five lines: a browser that denies storage but allows
 * cookies — Firefox with `dom.storage.enabled` off, or a full quota — passes the
 * signed-in check on the accept route and then finds nothing to redeem, so the
 * link reads "no longer valid" in that browser and stays that way. Memory covers
 * the case that needs no login round trip. One that does is a full navigation
 * and loses this, as it loses everything else in the document.
 */
let inMemoryToken: string | null = null;

/** The token `getCachedInviteToken` last returned, until the next `cacheInviteToken`. */
let cachedInviteToken: string | null = null;

export function cacheInviteToken(token: string): void {
  // A new token to cache, so the next `getCachedInviteToken` reads storage and clears it.
  cachedInviteToken = null;
  try {
    sessionStorage.setItem(STASH_KEY, token);
  } catch {
    inMemoryToken = token;
  }
}

/**
 * Whether a token is waiting to be redeemed.
 *
 * Storage only, and deliberately neither of the two module-level values around
 * it. The app route asks this to decide whether to send a caller back to the
 * accept page after a login bounce, and that is a question about a token that
 * outlived a document: one already taken must not send them back again, and one
 * held in memory belongs to a document that is gone.
 */
export function hasPendingInviteToken(): boolean {
  try {
    return sessionStorage.getItem(STASH_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Get the cached token, clearing it from storage.
 *
 * Idempotent until the next `cacheInviteToken`: the route gets it in `beforeLoad`, so
 * that storage is clear before any redirect can be thrown, and the component
 * asks again when it renders. Memoizing the answer means those two are the same
 * token rather than a token and a null, and clearing storage first means a page
 * that then fails to render cannot leave the app bouncing back here forever.
 */
export function getCachedInviteToken(): string | null {
  if (cachedInviteToken !== null) return cachedInviteToken;
  try {
    const stored = sessionStorage.getItem(STASH_KEY);
    if (stored !== null) sessionStorage.removeItem(STASH_KEY);
    cachedInviteToken = stored ?? inMemoryToken;
  } catch {
    cachedInviteToken = inMemoryToken;
  }
  inMemoryToken = null;
  return cachedInviteToken;
}

/** Test seam: forget the token and sign-up hint this page load has already taken. */
export function resetTakenInviteToken(): void {
  cachedInviteToken = null;
  inMemoryToken = null;
  signUpHinted = false;
}
