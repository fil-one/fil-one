import type { MeResponse } from '@filone/shared';

import { queryClient, queryKeys } from './query-client.js';
import { findMembershipByOrgId } from './org-membership-slug.js';

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
 *
 * Exported because `api.ts` waits out its auth redirects on the same clock, and
 * two numbers that have to agree are better as one.
 */
export const NAVIGATION_GIVE_UP_MS = 4000;

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
 *
 * Every route's own `beforeLoad` reaches `getMe()`, which is itself a held
 * `apiRequest` — so this latch has to come down before the navigation it is
 * guarding can ever settle. `getMe`'s `skipSwitchWait` option is how the two
 * routes on a switch's own critical path (`_app.tsx`, `$orgSlug.tsx`) read past
 * this latch instead of deadlocking against it; every other caller still waits.
 */
export function isSwitchingOrg(): boolean {
  return switching;
}

/** Subscribe to the latch. Returns the unsubscribe. */
export function onSwitchingOrgChange(listener: (switching: boolean) => void): () => void {
  switchingListeners.add(listener);
  return () => switchingListeners.delete(listener);
}

/**
 * Wait out a switch that is in progress.
 *
 * Resolves when the latch comes down, which is the rollback: the navigation
 * never happened, the previous stash is back, and a request held in that window
 * can go ahead against the org still on screen. It never resolves when the
 * navigation commits, which is the whole point of holding — the page is going,
 * and the answer would be discarded by the load anyway.
 *
 * Without this a held request has no resolution path at all. React Query starts
 * no second fetch for a key whose fetch is still in flight, so a cancelled
 * switch left every panel opened in that window spinning until a manual reload.
 */
export function waitWhileSwitching(): Promise<void> {
  if (!switching) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsubscribe = onSwitchingOrgChange((next) => {
      if (next) return;
      unsubscribe();
      resolve();
    });
  });
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
 * is left is the cancelled case, where `rollbackTo` becomes the stash again so
 * the tab keeps working. A switch names the org it came from, which is the one
 * still on screen. A refusal names nothing: the server has just declined that
 * org, and putting it back would re-attach the same header to every later
 * request and have each one refused in turn — the state the clear was for.
 *
 * `pagehide` also fires on the way into the back/forward cache, and what comes
 * back out of it is this same document: the latch is still up and the rollback
 * timer is already cancelled, so `apiRequest` would hold every request and the
 * switcher would stay disabled — a console that looks alive and does nothing.
 * The restored page is showing an org the user has left, so it reloads.
 */
function latchUntilNavigation(rollbackTo: string | null): void {
  setSwitching(true);

  const rollback = setTimeout(() => {
    stopListening();
    if (rollbackTo === null) clearActiveOrgId();
    else setActiveOrgId(rollbackTo);
    console.warn('[active-org] The navigation never happened — releasing the latch');
    setSwitching(false);
  }, NAVIGATION_GIVE_UP_MS);

  function stopListening(): void {
    window.removeEventListener('pagehide', cancel);
    window.removeEventListener('pageshow', restore);
  }

  // Only its own listener: the restore below is the other half of a bfcache
  // round trip, which starts with the `pagehide` this handles.
  function cancel(): void {
    clearTimeout(rollback);
    window.removeEventListener('pagehide', cancel);
  }

  function restore(event: PageTransitionEvent): void {
    if (!event.persisted || !switching) return;
    stopListening();
    window.location.reload();
  }

  window.addEventListener('pagehide', cancel);
  window.addEventListener('pageshow', restore);
}

/**
 * Clear the stash when this navigation commits, and not before.
 *
 * Logging out has to drop the org: `sessionStorage` belongs to the tab, and on
 * a shared machine the next person to sign in would otherwise start inside the
 * previous user's org whenever they are also a member of it. Clearing at the
 * click is too early, because the click may not become a navigation — the
 * upload page installs a `beforeunload` guard while a transfer is running, and
 * a user who answers "stay on this page" would be left rendering org B with no
 * stash, so every later request, a delete among them, lands in their personal
 * org instead.
 *
 * `pagehide` fires when the page really is going. A navigation that has not
 * committed by the time the switch latch would have given up is not coming, and
 * the listener goes rather than outliving the click it was registered for.
 */
export function clearActiveOrgOnNavigation(): void {
  const clear = (): void => {
    clearTimeout(giveUp);
    clearActiveOrgId();
  };
  const giveUp = setTimeout(() => {
    window.removeEventListener('pagehide', clear);
  }, NAVIGATION_GIVE_UP_MS);
  window.addEventListener('pagehide', clear, { once: true });
}

/**
 * Switch this tab to another org: stash the choice and navigate into it.
 *
 * `queryClient.clear()` rather than a full page load. No query key carries an
 * org dimension, and `/me` is cached under two keys with a ten-minute stale
 * time, so clearing every cached query is what used to make a full reload the
 * only safe option — with the cache empty, a router navigation cannot leak
 * org A's data into org B's view either, and it does not cost a full document
 * load to get there. A soft switch — org id in every key instead of a clear —
 * is later polish.
 *
 * The target org's own `/dashboard` rather than the current URL: bucket names,
 * key ids and every other path segment are org-scoped, so navigating in place
 * would greet the user with a not-found page in the org they just chose.
 *
 * `landOn` picks that landing page. A switch between existing orgs wants the
 * dashboard, but creating one lands on `get-started`: the new org is empty, so
 * its dashboard is all zeroes, while get-started is the two things that empty
 * org actually needs next. It only takes effect with a slug — get-started is
 * org-scoped with no unscoped route to fall back to, so a slugless target lands
 * on `/dashboard` regardless, and resolves itself from there.
 *
 * The router import is dynamic to avoid a cycle: `router.ts` pulls in every
 * route, several of which import this module (via `api.ts`) at the top level,
 * so a static import back here would be resolved before either side's module
 * body has finished running.
 *
 * The slug comes from this tab's own cached `/me` unless `knownSlug` is
 * given. `OrgSwitcher` only ever has the org id, so it falls to the cache —
 * fine there, since a membership already in `/me`'s list is exactly what a
 * row in that switcher is. A caller switching into an org that was *not* in
 * any cache a moment ago (accepting an invitation, creating a new org) has
 * to pass the slug its own response just carried: the cache lookup would
 * otherwise always miss for that org specifically, and the unscoped
 * `/dashboard` fallback it misses into is not a dead end (it resolves the
 * org id into a slugged URL itself, once `/me` is fetched fresh) but it is a
 * second, avoidable redirect. A target org with no slug backfilled yet still
 * falls back the same way regardless of which source came up empty.
 */
export function switchToOrg(
  orgId: string,
  knownSlug?: string,
  landOn: 'dashboard' | 'get-started' = 'dashboard',
): void {
  const previousOrgId = getActiveOrgId();
  const targetSlug = knownSlug ?? resolveOrgSlug(orgId);
  setActiveOrgId(orgId);
  setSwitching(true);
  queryClient.clear();

  void (async () => {
    try {
      const { router } = await import('../router.js');
      if (targetSlug) {
        await router.navigate({
          to: landOn === 'get-started' ? '/$orgSlug/get-started' : '/$orgSlug/dashboard',
          params: { orgSlug: targetSlug },
        });
      } else {
        await router.navigate({ to: '/dashboard' });
      }
      setSwitching(false);
    } catch (error) {
      // The navigation was blocked or failed — a `beforeLoad` redirect threw
      // somewhere unexpected, say. Roll the stash back to where this tab was,
      // the same recovery a cancelled full-page switch used to get from
      // `latchUntilNavigation`'s `pagehide` listener, which a client-side
      // navigation never fires.
      console.warn('[active-org] The switch navigation did not complete — rolling back', error);
      if (previousOrgId === null) clearActiveOrgId();
      else setActiveOrgId(previousOrgId);
      setSwitching(false);
    }
  })();
}

/** The slug for `orgId`, as this tab's cached `/me` currently knows it. */
function resolveOrgSlug(orgId: string): string | undefined {
  const me = queryClient.getQueryData<MeResponse>(queryKeys.me);
  if (!me) return undefined;
  return findMembershipByOrgId(me, orgId)?.slug;
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
 * The comparison is against the org the request was *sent* under, not whatever
 * the stash holds when the answer lands. A `/me` for org A can still be in
 * flight when the switcher stashes org B: read against the new stash, A's
 * honest echo looks like a refusal, and the recovery would clear the stash and
 * reload — undoing the switch the user just made. It happens whenever the
 * switch's own navigation is cancelled, which the latch below already exists
 * for.
 *
 * @param resolvedOrgId the org `/me` says it served.
 * @param requestedOrgId the org that request named, `null` for no header.
 * @returns whether a reload was triggered.
 */
export function reconcileActiveOrg(
  resolvedOrgId: string | undefined,
  requestedOrgId: string | null,
): boolean {
  const stashed = getActiveOrgId();
  if (stashed !== requestedOrgId) return false;
  if (!stashed || !resolvedOrgId || stashed === resolvedOrgId) return false;

  console.warn('[active-org] The server resolved a different org than this tab asked for', {
    requested: stashed,
    resolved: resolvedOrgId,
  });
  clearActiveOrgId();
  noteReconcile();
  // Cleared is where a cancelled reload has to leave the tab: the org it asked
  // for is not the org it got, and asking again would go the same way.
  latchUntilNavigation(null);
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
  // The refused org does not come back if the reload is cancelled. Restoring it
  // would send the same header to every later request, and `/me` among them is
  // the one call whose answer could have fixed the tab.
  latchUntilNavigation(null);
  window.location.reload();
  return true;
}
