const ACTIVE_ORG_KEY = 'filone:activeOrgId';

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
    // Nothing was stored, so nothing needs clearing.
  }
}

/**
 * Switch this tab to another org: stash the choice and reload.
 *
 * A full reload rather than query invalidation. No query key carries an org
 * dimension, and `/me` is cached under two keys with a ten-minute stale time, so
 * a reload is the one mechanism that cannot leak org A's cache into org B's
 * view. A soft switch — org id in every key — is later polish.
 */
export function switchToOrg(orgId: string): void {
  setActiveOrgId(orgId);
  window.location.reload();
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
  window.location.reload();
  return true;
}
