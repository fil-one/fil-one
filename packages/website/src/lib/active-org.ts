import { useQuery } from '@tanstack/react-query';

import { getMe } from './api.js';
import { ME_STALE_TIME, queryClient, queryKeys } from './query-client.js';
import { cancelGuardedWork, leaveGuardedWork } from './use-warn-before-unload.js';

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
 * A new tab starts from the org the user last switched to, so coming back to
 * the console reopens it. See {@link seedActiveOrgFromLastUsed}.
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
    sessionStorage.removeItem(ACTIVE_ORG_USER_KEY);
  } catch {
    // Storage disabled, so there was nothing stored to clear.
  }
}

const ACTIVE_ORG_USER_KEY = 'filone:activeOrgUserId';

/**
 * The user who chose this tab's org, by switching to it or by having saved it
 * as their last-used org. Kept beside the org so that whoever signs in next in
 * this tab, after a logout or an expired session, is checked against it (see
 * {@link settleActiveOrg}). Absent when nothing has named the user yet: a
 * switch made before any `/me` in its page load answered, or a tab from before
 * this record existed. Such a tab learns it from its next `/me`.
 */
function getActiveOrgUserId(): string | null {
  try {
    return sessionStorage.getItem(ACTIVE_ORG_USER_KEY);
  } catch {
    return null;
  }
}

function setActiveOrgUserId(userId: string): void {
  try {
    sessionStorage.setItem(ACTIVE_ORG_USER_KEY, userId);
  } catch {
    // Storage disabled, so there is no org to check it against either.
  }
}

function clearActiveOrgUserId(): void {
  try {
    sessionStorage.removeItem(ACTIVE_ORG_USER_KEY);
  } catch {
    // Storage disabled, so there was nothing stored to clear.
  }
}

const LAST_USED_ORG_KEY = 'filone:lastUsedOrg';

/**
 * The org the user last switched to, and who that user was. Only saved when
 * the user is known, so a new tab can always be checked against whoever signs
 * in (see {@link settleActiveOrg}).
 */
interface LastUsedOrg {
  orgId: string;
  userId: string;
}

/**
 * Start a new tab in the org the user last switched to. Called on every page
 * load, before the first request, but it acts once per tab: a reload, or the
 * reload a recovery starts, keeps the org the tab has, its home org included,
 * so a switch in one tab still never moves another one (see
 * {@link getActiveOrgId}). Logging out, or a different user signing in, lets
 * the tab start again from the last-used org.
 *
 * The last-used org lives in `localStorage`, so it outlives the tab, the
 * browser and a logout.
 *
 * The user who saved it comes along into this tab, so the check against the
 * signed-in user does not depend on what other tabs write afterwards. The org
 * is also marked as seeded until a `/me` accepts it, because until then the
 * user has not chosen it in this tab: an org they can no longer reach is
 * dropped silently.
 */
export function seedActiveOrgFromLastUsed(): void {
  if (hasSeedRun()) return;
  // Marked first, so a tab that already has an org (one opened before this
  // seed existed) does not get seeded on the reload a recovery starts.
  markSeedRun();
  if (getActiveOrgId() !== null) return;
  const lastUsed = getLastUsedOrg();
  if (lastUsed === null) return;
  setActiveOrgId(lastUsed.orgId);
  setActiveOrgUserId(lastUsed.userId);
  try {
    sessionStorage.setItem(SEEDED_ORG_KEY, lastUsed.orgId);
  } catch {
    // Storage disabled, so `setActiveOrgId` stored nothing either.
  }
}

const SEED_RUN_KEY = 'filone:activeOrgSeedRun';

function hasSeedRun(): boolean {
  try {
    return sessionStorage.getItem(SEED_RUN_KEY) !== null;
  } catch {
    return false;
  }
}

function markSeedRun(): void {
  try {
    sessionStorage.setItem(SEED_RUN_KEY, '1');
  } catch {
    // Storage disabled, so the seed stores nothing either.
  }
}

/** Let this tab start from the last-used org again on its next load. */
function clearSeedRun(): void {
  try {
    sessionStorage.removeItem(SEED_RUN_KEY);
  } catch {
    // Storage disabled, so there was nothing stored to clear.
  }
}

const SEEDED_ORG_KEY = 'filone:activeOrgSeeded';

/** Whether this tab is in `orgId` only because it was seeded there. */
function isSeededOrg(orgId: string): boolean {
  try {
    return sessionStorage.getItem(SEEDED_ORG_KEY) === orgId;
  } catch {
    return false;
  }
}

function clearSeededOrg(): void {
  try {
    sessionStorage.removeItem(SEEDED_ORG_KEY);
  } catch {
    // Storage disabled, so there was nothing stored to clear.
  }
}

/**
 * The user the latest `/me` in this page load named, taken as who makes any
 * switch here, even when the switch's own `/me` fails. Another tab can sign
 * someone else in under this page, since the session cookie is shared. A
 * switch from such a stale page then names the previous user, and its own
 * `/me` drops the org through the user check. Module state, so it starts empty
 * on every load.
 */
let signedInUserId: string | undefined;

/** Called by `getMe` with every answer, before any check runs. */
export function noteSignedInUser(userId: string | undefined): void {
  if (userId !== undefined) signedInUserId = userId;
}

/**
 * Check this tab's org against the user a `/me` names, on every `/me`.
 *
 * Chosen by a different user (the tab outlived a logout or an expired session,
 * or was seeded from someone else's visit), the org is dropped and the tab
 * reloads into the signed-in user's own org, with no notice: they did not pick
 * it. The server would serve the org if both people belong to it, so nothing
 * else catches this.
 *
 * Accepted for the same user, the org becomes the tab's own: the seeded mark
 * goes, so losing it later gets the usual notice, and a tab whose switch landed
 * before any `/me` named the user learns who chose it. Refused, it is left to
 * the recovery in {@link reconcileActiveOrg} or
 * {@link clearActiveOrgAfterRefusal}, which stays silent while the mark is
 * there.
 *
 * @param userId the user `/me` says is signed in.
 * @param resolvedOrgId the org `/me` says it served.
 * @param requestedOrgId the org that request named, `null` for no header.
 * @returns whether a reload was triggered.
 */
export function settleActiveOrg(
  userId: string | undefined,
  resolvedOrgId: string | undefined,
  requestedOrgId: string | null,
): boolean {
  // The answer is about the org it was asked for, and the tab may have
  // switched since (see `reconcileActiveOrg`).
  if (requestedOrgId === null || getActiveOrgId() !== requestedOrgId) return false;
  if (userId === undefined) return false;

  const chosenBy = getActiveOrgUserId();
  if (chosenBy !== null && chosenBy !== userId) {
    // A last-used org saved by anyone but the signed-in user goes too. Kept,
    // every new tab they open would start in it and reload once more. The
    // cost: the previous user's next sign-in here opens their home org.
    if (getLastUsedOrg()?.userId !== userId) clearLastUsedOrgId();
    clearSeededOrg();
    clearActiveOrgId();
    // The reload may start from the signed-in user's own last-used org.
    clearSeedRun();
    // Nothing the signed-in user started belongs in the other user's org.
    cancelGuardedWork();
    latchUntilNavigation();
    window.location.reload();
    return true;
  }
  if (resolvedOrgId !== requestedOrgId) return false;
  if (chosenBy === null) setActiveOrgUserId(userId);
  clearSeededOrg();
  return false;
}

function getLastUsedOrg(): LastUsedOrg | null {
  try {
    const stored = localStorage.getItem(LAST_USED_ORG_KEY);
    if (stored === null) return null;
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (!('orgId' in parsed) || typeof parsed.orgId !== 'string') return null;
    if (!('userId' in parsed) || typeof parsed.userId !== 'string') return null;
    return { orgId: parsed.orgId, userId: parsed.userId };
  } catch {
    // Storage disabled, or a value this code did not write.
    return null;
  }
}

function setLastUsedOrg(lastUsed: LastUsedOrg): void {
  try {
    localStorage.setItem(LAST_USED_ORG_KEY, JSON.stringify(lastUsed));
  } catch {
    // Storage disabled: a new tab starts in the home org, as before.
  }
}

/**
 * Forget the last-used org. With `orgId`, only when it names that org: another
 * tab may have switched somewhere valid since this tab chose the org being
 * dropped, and that later choice stays.
 */
export function clearLastUsedOrgId(orgId?: string): void {
  try {
    if (orgId === undefined || getLastUsedOrg()?.orgId === orgId) {
      localStorage.removeItem(LAST_USED_ORG_KEY);
    }
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

type SwitchingListener = (switching: boolean, outcome?: SwitchOutcome) => void;

/** Told the latch went up or came down, so React can re-render the switcher. */
const switchingListeners = new Set<SwitchingListener>();

/**
 * Whether this tab is between orgs.
 *
 * `switchToOrg` and `reconcileActiveOrg` both navigate, and a browser takes its
 * time about it: requests started in that window carry the new stash value while
 * the page still shows the old org, and their answers are discarded by the
 * navigation anyway. `apiRequest` holds them instead, and the switcher disables
 * its buttons, so nothing is issued against an org the user has already left.
 * `_app.tsx`'s `beforeLoad` reads past it with `skipSwitchWait`.
 */
export function isSwitchingOrg(): boolean {
  return switching;
}

/** Subscribe to the latch. Returns the unsubscribe. */
export function onSwitchingOrgChange(listener: SwitchingListener): () => void {
  switchingListeners.add(listener);
  return () => switchingListeners.delete(listener);
}

/**
 * How a switch ended: its navigation landed in the new org, or it never did and
 * the previous stash is back.
 */
export type SwitchOutcome = 'committed' | 'rolledBack';

/**
 * Wait out a switch that is in progress, and say how it ended.
 *
 * Resolves `null` straight away when no switch is running. Otherwise it resolves
 * when the latch comes down, with the outcome, and the caller decides what a
 * held request may still do. A rollback means the navigation never happened and
 * the previous stash is back, so the request can go ahead against the org still
 * on screen. A commit means the stash now names the org the user moved to, and
 * a request held from the page they left would go out under that org's header.
 *
 * Without the rollback path a held request has no resolution at all. React Query
 * starts no second fetch for a key whose fetch is still in flight, so a cancelled
 * switch left every panel opened in that window spinning until a manual reload.
 */
export function waitWhileSwitching(): Promise<SwitchOutcome | null> {
  if (!switching) return Promise.resolve(null);
  return new Promise<SwitchOutcome>((resolve) => {
    const unsubscribe = onSwitchingOrgChange((next, outcome) => {
      if (next || !outcome) return;
      unsubscribe();
      resolve(outcome);
    });
  });
}

function setSwitching(next: true): void;
function setSwitching(next: false, outcome: SwitchOutcome): void;
function setSwitching(next: boolean, outcome?: SwitchOutcome): void {
  switching = next;
  // The pending display below is only ever meaningful while a switch is in
  // flight — once the latch comes back down, either the real `/me` has landed
  // (the sidebar has the true name now) or the switch was rolled back (the
  // stub named an org the tab never actually reached). Both cases want it
  // gone, so it rides this same transition rather than a copy of the logic at
  // every place `switchToOrg` itself brings the latch down.
  if (!next) queryClient.setQueryData(queryKeys.pendingOrgSwitch, null);
  for (const listener of switchingListeners) listener(next, outcome);
}

export type PendingOrgSwitchTarget = {
  orgId: string;
  orgName: string;
  logoUrl?: string;
};

/**
 * The org a switch in flight is headed for, painted from the switcher row the
 * caller just clicked rather than waited on the network for.
 *
 * `switchToOrg`'s `queryClient.clear()` is what makes a client-side navigation
 * safe instead of a full reload (see its own doc comment), but it also throws
 * away the `memberships` list the sidebar reads its header from — so for
 * however long the destination route's `beforeLoad` takes to bring back a
 * fresh `/me`, the sidebar has nothing to name the org with. The row just
 * clicked already carried that org's name and logo; this is where `switchToOrg`
 * hands them forward instead of letting them be discarded a moment later.
 *
 * Deliberately not folded into `['me']`: this is never fetched, only ever
 * `setQueryData`'d, and carries nothing beyond display — no permissions, no
 * role, nothing a stale value could make a gated surface trust.
 */
export function usePendingOrgSwitchTarget(): PendingOrgSwitchTarget | null {
  const { data } = useQuery({
    queryKey: queryKeys.pendingOrgSwitch,
    // Never actually runs: nothing here calls `fetchQuery`/`refetch` on this
    // key, only `setQueryData`. `enabled: false` says so, and a `queryFn` is
    // still required to satisfy the type.
    queryFn: () => null as PendingOrgSwitchTarget | null,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data ?? null;
}

/**
 * Raise the latch before a reload, and take it down again if the reload never
 * happens.
 *
 * A `beforeunload` handler can cancel it — the upload page installs one while a
 * transfer is running, and a user who answers "stay on this page" leaves a tab
 * that asked to reload and did not. Without a way back, `apiRequest` holds every
 * request forever and the switcher's rows stay inert.
 *
 * `pagehide` fires when the page really is going, and cancels the rollback. In
 * the cancelled case the stash stays cleared: the server has just declined that
 * org, and putting it back would re-attach the same header to every later
 * request and have each one refused in turn.
 *
 * `pagehide` also fires on the way into the back/forward cache, and what comes
 * back out of it is this same document: the latch is still up and the rollback
 * timer is already cancelled, so `apiRequest` would hold every request and the
 * switcher would stay disabled — a console that looks alive and does nothing.
 * The restored page is showing an org the user has left, so it reloads.
 */
function latchUntilNavigation(): void {
  setSwitching(true);

  const rollback = setTimeout(() => {
    stopListening();
    clearActiveOrgId();
    console.warn('[active-org] The navigation never happened — releasing the latch');
    setSwitching(false, 'rolledBack');
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
 * previous user's org whenever they are also a member of it. The last-used org
 * stays, so the same user signing back in returns to it; another user's first
 * `/me` drops it (see {@link settleActiveOrg}). Clearing at the
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
    // Signing back in, in this same tab, starts from the last-used org.
    clearSeedRun();
  };
  const giveUp = setTimeout(() => {
    window.removeEventListener('pagehide', clear);
  }, NAVIGATION_GIVE_UP_MS);
  window.addEventListener('pagehide', clear, { once: true });
}

/**
 * Record a switch whose navigation finished: the tab's org becomes the user's
 * own pick, and the next tab's starting org.
 *
 * Only once the tab is really there. A rolled-back switch never gets here, but
 * a refused one does: `_app.tsx`'s `beforeLoad` lets the navigation finish
 * after `/me` refuses the org, and the recovery that `/me` starts has already
 * cleared the stash. Neither may become the org the next tab opens in.
 */
function recordLandedSwitch(orgId: string): void {
  if (getActiveOrgId() !== orgId) return;
  // Losing the org later deserves a word.
  clearSeededOrg();
  // Unknown only when no `/me` in this page load has named the user. The next
  // tab is then not seeded from a choice nobody can be checked against, and
  // this tab learns who chose its org at its next `/me`.
  if (signedInUserId === undefined) return;
  setActiveOrgUserId(signedInUserId);
  setLastUsedOrg({ orgId, userId: signedInUserId });
}

/** Put back the org, and who chose it, that a switch replaced. */
function restoreActiveOrg(orgId: string | null, chooser: string | null): void {
  if (orgId === null) clearActiveOrgId();
  else setActiveOrgId(orgId);
  if (chooser === null) clearActiveOrgUserId();
  else setActiveOrgUserId(chooser);
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
 * `/dashboard` rather than the current page: bucket names, key ids and every
 * other path segment belong to the org being left, so staying in place would
 * greet the user with a not-found page in the org they just chose. The page is
 * keyed on the active org (see `_app.tsx`), so it remounts even when the tab was
 * already on `/dashboard`.
 *
 * `landOn` picks that landing page. A switch between existing orgs wants the
 * dashboard, but creating one lands on `get-started`: the new org is empty, so
 * its dashboard is all zeroes, while get-started is the two things that empty
 * org actually needs next.
 *
 * The router import is dynamic to avoid a cycle: `router.ts` pulls in every
 * route, several of which import this module (via `api.ts`) at the top level,
 * so a static import back here would be resolved before either side's module
 * body has finished running.
 *
 * `knownDisplay` is the org's name and logo, when the caller already has them
 * on hand — every call site does, since a switcher row and a just-created
 * org's response both carry them. Seeded as `usePendingOrgSwitchTarget` right
 * after the clear below, so the sidebar has the right name to paint the
 * instant the switch starts rather than the `'Organization'` fallback for
 * however long the fresh `/me` takes.
 *
 * @returns whether the switch started. False when the user declined to leave
 * guarded work (a running upload) behind, in which case nothing changed.
 */
export function switchToOrg(
  orgId: string,
  landOn: 'dashboard' | 'get-started' = 'dashboard',
  knownDisplay?: { orgName: string; logoUrl?: string },
): boolean {
  // A client-side navigation fires no `beforeunload`, so the upload page's
  // guard is asked here instead, before anything about the tab has changed:
  // declining leaves the stash, the cache, and the page exactly as they were.
  // Agreeing cancels the upload here too, before the stash moves: its later
  // batches read the stash when they go out, so an upload left running would
  // carry on into the org the user is switching to.
  if (!leaveGuardedWork()) return false;

  const previousOrgId = getActiveOrgId();
  const previousChooser = getActiveOrgUserId();
  setActiveOrgId(orgId);
  // The signed-in user picked this org, whoever chose the one before it (a tab
  // seeded from another user's visit, say).
  if (signedInUserId === undefined) clearActiveOrgUserId();
  else setActiveOrgUserId(signedInUserId);
  setSwitching(true);
  queryClient.clear();
  // The new org's `/me`, started before anything can render. A component that
  // re-renders before the navigation below (the create dialog closing, say)
  // finds the cache empty and reads `/me`; `apiRequest` would hold that read
  // until the switch ends. `_app.tsx`'s `beforeLoad` joins whatever `/me` is in
  // flight rather than starting its own, so it would wait on the held read, and
  // the switch ends only once `beforeLoad` does. Started here, unheld, there is
  // nothing held for anyone to join. Same options as that `beforeLoad` call.
  void queryClient.prefetchQuery({
    queryKey: queryKeys.me,
    queryFn: () => getMe({ skipSwitchWait: true }),
    staleTime: ME_STALE_TIME,
  });
  if (knownDisplay) {
    queryClient.setQueryData(queryKeys.pendingOrgSwitch, {
      orgId,
      orgName: knownDisplay.orgName,
      logoUrl: knownDisplay.logoUrl,
    } satisfies PendingOrgSwitchTarget);
  }

  void (async () => {
    try {
      const { router } = await import('../router.js');
      await router.navigate({ to: landOn === 'get-started' ? '/get-started' : '/dashboard' });
      recordLandedSwitch(orgId);
      setSwitching(false, 'committed');
    } catch (error) {
      // The navigation was blocked or failed — a `beforeLoad` redirect threw
      // somewhere unexpected, say. Roll the stash back to where this tab was.
      console.warn('[active-org] The switch navigation did not complete — rolling back', error);
      restoreActiveOrg(previousOrgId, previousChooser);
      setSwitching(false, 'rolledBack');
      // The `/me` started above is about the org the tab never reached. Kept,
      // it would name that org over this one's pages for `ME_STALE_TIME`, and
      // the reconcile in `getMe` cannot catch it: it compares against the org
      // the request was sent under. A reset drops it, and any mounted reader
      // fetches again under the restored stash.
      void queryClient.resetQueries({ queryKey: queryKeys.me });
    }
  })();

  return true;
}

/**
 * Send this tab to `/left-organization` once the caller has left their last
 * org. The removal gave the account a floor org and pointed its home at it, so
 * with the stash cleared the next `/me` resolves there, and every cached query
 * belonged to the org just left. The caller has already cancelled any running
 * work, which is why this does not ask {@link leaveGuardedWork} the way
 * {@link switchToOrg} does.
 */
export function moveToLeftOrganization(): void {
  clearActiveOrgId();
  // The account has no org left but the floor org, so the last-used one is gone.
  clearLastUsedOrgId();
  queryClient.clear();
  void import('../router.js').then(({ router }) => router.navigate({ to: '/left-organization' }));
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
  // Running work was headed into the org this tab can no longer reach. Were it
  // left running and the reload declined, its later requests would go out with
  // no header, into whatever org the server resolves instead.
  cancelGuardedWork();
  // Kept, it would seed the next tab into the same refusal.
  clearLastUsedOrgId(stashed);
  clearActiveOrgId();
  noteReconcile(stashed);
  latchUntilNavigation();
  window.location.reload();
  return true;
}

/**
 * Leave word for the page that comes back that its org changed under it, unless
 * the org came from an earlier visit rather than a choice made in this tab (see
 * {@link seedActiveOrgFromLastUsed}).
 */
function noteReconcile(droppedOrgId: string): void {
  const seeded = isSeededOrg(droppedOrgId);
  clearSeededOrg();
  if (seeded) return;
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
  // As in `reconcileActiveOrg`: running work was headed into the refused org,
  // and the next tab must not be seeded into it.
  cancelGuardedWork();
  clearLastUsedOrgId(stashed);
  clearActiveOrgId();
  noteReconcile(stashed);
  latchUntilNavigation();
  window.location.reload();
  return true;
}
