import { API_URL } from '../env.js';

const PENDING_KEY = 'filone:pendingMfaAction';

interface PendingAction {
  action: string;
  returnTo: string;
}

/**
 * Stash the in-flight action and current location, then redirect to the
 * server-side login endpoint with the OIDC PAPE multi-factor `acr_values`.
 * Auth0 challenges MFA in the post-login Action and emits `amr: ["mfa"]` on
 * the new ID token. After the round trip, the post-login bounce in the app
 * root reads sessionStorage and navigates back to `returnTo` with
 * `?action=<action>`.
 */
export function redirectToStepUp(action: string): void {
  const returnTo = window.location.pathname + window.location.search;
  const pending: PendingAction = { action, returnTo };
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    // Private mode / storage disabled — proceed anyway; user will land on
    // /dashboard after the round-trip and can re-trigger the action manually.
  }
  const params = new URLSearchParams({
    acr_values: 'http://schemas.openid.net/pape/policies/2007/06/multi-factor',
  });
  window.location.href = `${API_URL}/login?${params.toString()}`;
}

/**
 * Read and clear any pending step-up action stashed by `redirectToStepUp`.
 * Returns null if nothing is pending or the stash is malformed.
 */
export function consumePendingMfaAction(): PendingAction | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(PENDING_KEY);
    if (raw) sessionStorage.removeItem(PENDING_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingAction;
    if (typeof parsed.action !== 'string' || typeof parsed.returnTo !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}
