const PENDING_KEY = 'filone:pendingOrgPaymentPrompt';

/**
 * Stash that `orgId` was just created with no free trial — see
 * `trial-claim.ts`'s `isSoloPersonalOrg`, which only grants one to an account's
 * first org — so its first `get-started` view knows to open the payment
 * prompt on arrival rather than leave the caller to notice "No active plan" on
 * their own.
 *
 * `sessionStorage`, the same idiom `step-up.ts` uses for a pending action that
 * has to survive a navigation: `switchToOrg` clears the query cache and
 * navigates before the prompt's own page ever mounts, so nothing in memory
 * would carry the flag across that gap.
 */
export function stashPendingOrgPaymentPrompt(orgId: string): void {
  try {
    sessionStorage.setItem(PENDING_KEY, orgId);
  } catch {
    // Private mode / storage disabled — the prompt just does not auto-open;
    // Billing is still reachable manually.
  }
}

/**
 * Whether `orgId`'s `get-started` view should auto-open the payment prompt.
 *
 * Consumes the stash so it fires once, even across a reload: a caller who
 * dismisses the prompt and reloads the page should not have it reopen on them,
 * and Billing itself is still there for whenever they are ready.
 *
 * Checked against `orgId` rather than answered unconditionally, so a stash
 * from creating org A does not fire on a tab that has since switched into org
 * B some other way.
 */
export function consumePendingOrgPaymentPrompt(orgId: string): boolean {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(PENDING_KEY);
    if (raw) sessionStorage.removeItem(PENDING_KEY);
  } catch {
    return false;
  }
  return raw === orgId;
}
