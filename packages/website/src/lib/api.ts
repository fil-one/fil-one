import { API_URL } from '../env.js';
import { ApiErrorCode, CSRF_COOKIE_NAME } from '@filone/shared';
import type { StepUpRequiredResponse } from '@filone/shared';
import { redirectToStepUp } from './step-up.js';
import type { PreferencesResponse, UpdatePreferencesRequest } from '@filone/shared';

// Prevents multiple simultaneous 401 responses from each triggering a redirect.
let isRedirecting = false;

/** Sentinel error subclass thrown when the backend returns step_up_required. */
export class StepUpRequiredError extends Error {
  constructor() {
    super('Step-up authentication required');
  }
}

function getCsrfToken(): string | undefined {
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`))
    ?.split('=')[1];
}

/**
 * Redirect to the server-side login endpoint which handles OAuth state
 * generation and redirects to Auth0 Universal Login.
 */
export function redirectToLogin(): void {
  if (isRedirecting) return;
  isRedirecting = true;
  window.location.href = `${API_URL}/login`;
}

export function logout(): void {
  window.location.href = `${API_URL}/logout`;
}

/**
 * The session/identity probe, and nothing else. `/me/profile`,
 * `/me/preferences`, `/me/change-password` and `/me/resend-verification` are
 * ordinary endpoints and are deliberately excluded — only the bare `/me`, with
 * or without a query string, reports on the identity itself.
 */
function isSessionProbe(path: string): boolean {
  return path === '/me' || path.startsWith('/me?');
}

/**
 * FIL-112: raise ACCOUNT_DELETED, and — only when the *session probe* is what
 * returned it — send the browser to the static confirmation page. Redirecting
 * to /login instead would loop forever, because the Auth0 SSO session silently
 * re-authenticates the tombstoned identity.
 *
 * The navigation is scoped on purpose, and the discriminator is narrower than
 * the code's name suggests. ACCOUNT_DELETED does not mean "this account is
 * gone" on every endpoint: several backend handlers emit it off the `deleting`
 * fence, which an org can carry with no deletion ever having completed (see
 * `lib/deletion-guards.ts`, whose unwedge helper exists for exactly that
 * state). Navigating on those would evict a live, paying user onto a page
 * telling them their account is gone while their session still works. So what
 * this function acts on is only ever: *the session probe said the identity is
 * gone*.
 *
 * A genuinely tombstoned session still reaches the page — the auth middleware
 * answers ACCOUNT_DELETED for every request, so the SPA's next `/me` refetch
 * produces the navigation.
 *
 * Every path throws, probe or not, so `query-client` refuses to retry and a
 * non-probe caller renders an inline error instead.
 *
 * Keyed on the error code, never on the status: the backend emits this from
 * one shared helper as 410, and 410 is also in use for an expired deletion
 * code, so the status alone cannot identify the condition.
 */
function throwAccountDeleted(status: number, fromSessionProbe: boolean): never {
  if (fromSessionProbe && !isRedirecting) {
    isRedirecting = true;
    window.location.href = '/account-deleted';
  }
  throw Object.assign(new Error('Account has been deleted'), {
    status,
    code: ApiErrorCode.ACCOUNT_DELETED,
  });
}

/**
 * Wrapper around fetch for all Fil.one API calls.
 * - Always sends HttpOnly auth cookies via credentials: 'include'
 * - Redirects to Auth0 login on 401
 * - Throws on any ACCOUNT_DELETED response, and redirects to /account-deleted
 *   when it was the session probe that returned it
 */
// eslint-disable-next-line complexity/complexity
export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = options.method?.toUpperCase() ?? 'GET';
  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const token = getCsrfToken();
    if (token) headers.set('X-CSRF-Token', token);
  }

  const response = await fetch(`${API_URL}/api${path}`, {
    ...options,
    credentials: 'include',
    headers,
  });

  // Checked ahead of every status-specific branch below, so the condition is
  // handled whatever status carries it. `clone()` leaves the body unread for
  // those branches.
  if (!response.ok) {
    const body = (await response
      .clone()
      .json()
      .catch(() => ({}))) as { code?: string };
    if (body.code === ApiErrorCode.ACCOUNT_DELETED) {
      throwAccountDeleted(response.status, isSessionProbe(path));
    }
  }

  if (response.status === 401) {
    const body = (await response
      .clone()
      .json()
      .catch(() => ({}))) as Partial<StepUpRequiredResponse>;
    if (body.error === 'step_up_required') {
      throw new StepUpRequiredError();
    }
    redirectToLogin();
    // Throw so the caller's promise chain stops — the page is navigating away
    throw Object.assign(new Error('Session expired. Redirecting to login...'), { status: 401 });
  }

  if (response.status === 402) {
    const body = (await response.json().catch(() => ({}))) as { message?: string; code?: string };
    if (body.code === ApiErrorCode.TRIAL_PRESIGN_BLOCKED) {
      throw Object.assign(
        new Error(
          'Generating shareable links is not available on trial accounts. Please upgrade to a paid plan.',
        ),
        { status: 402, code: ApiErrorCode.TRIAL_PRESIGN_BLOCKED },
      );
    }
  }

  if (response.status === 403) {
    const body = (await response.json().catch(() => ({}))) as { message?: string; code?: string };
    if (body.code === ApiErrorCode.EMAIL_NOT_VERIFIED) {
      if (!isRedirecting) {
        isRedirecting = true;
        window.location.href = '/verify-email';
      }
      throw Object.assign(new Error('Email verification required'), { status: 403 });
    }
    if (body.code === ApiErrorCode.GRACE_PERIOD_WRITE_BLOCKED) {
      throw Object.assign(
        new Error(
          'Your account is in a grace period. Read-only access is available. Please reactivate your subscription to make changes.',
        ),
        { status: 403 },
      );
    }
    if (body.code === ApiErrorCode.SUBSCRIPTION_CANCELED) {
      throw Object.assign(
        new Error('Your subscription has been canceled. Please reactivate to regain access.'),
        { status: 403 },
      );
    }
    throw Object.assign(new Error(body.message ?? 'Access denied'), { status: 403 });
  }

  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      message?: string;
      code?: string;
      resendAvailableAt?: string;
    };
    throw Object.assign(
      new Error(error.message ?? `Request failed with status ${response.status}`),
      {
        status: response.status,
        // Pass structured error details through so callers can branch on the
        // error code or honor server-enforced cooldowns (e.g. the 429 from
        // the deletion-challenge endpoint carries resendAvailableAt).
        ...(error.code !== undefined && { code: error.code }),
        ...(error.resendAvailableAt !== undefined && {
          resendAvailableAt: error.resendAvailableAt,
        }),
      },
    );
  }

  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

// ── Me / Org API ────────────────────────────────────────────────────────

import type {
  MeResponse,
  UpdateProfileRequest,
  UpdateProfileResponse,
  RegenerateRecoveryCodeResponse,
} from '@filone/shared';

export function getMe(options?: { forceRefresh?: boolean; include?: 'mfa' }): Promise<MeResponse> {
  const params = new URLSearchParams();
  if (options?.forceRefresh) params.set('forceRefresh', '1');
  if (options?.include) params.set('include', options.include);
  const qs = params.toString();
  return apiRequest<MeResponse>(`/me${qs ? `?${qs}` : ''}`);
}

export function updateProfile(data: UpdateProfileRequest): Promise<UpdateProfileResponse> {
  return apiRequest<UpdateProfileResponse>('/me/profile', {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function changePassword(): Promise<{ message: string }> {
  return apiRequest<{ message: string }>('/me/change-password', { method: 'POST' });
}

export function resendVerificationEmail(): Promise<{ message: string }> {
  return apiRequest<{ message: string }>('/me/resend-verification', { method: 'POST' });
}

// ── Preferences API ─────────────────────────────────────────────────────

export function getPreferences(): Promise<PreferencesResponse> {
  return apiRequest<PreferencesResponse>('/me/preferences');
}

export function updatePreferences(data: UpdatePreferencesRequest): Promise<PreferencesResponse> {
  return apiRequest<PreferencesResponse>('/me/preferences', {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

// ── MFA API ──────────────────────────────────────────────────────────────

export async function enrollMfa(): Promise<void> {
  await apiRequest<{ message: string }>('/mfa/enroll', { method: 'POST' });
  // Force a fresh login. The backend has set app_metadata.mfa_enrolling = true,
  // so the Post-Login Action will trigger MFA enrollment via Universal Login.
  redirectToLogin();
}

export function disableMfa(): Promise<{ message: string }> {
  return apiRequest<{ message: string }>('/mfa/disable', { method: 'POST' });
}

export function deleteMfaEnrollment(enrollmentId: string): Promise<{ message: string }> {
  return apiRequest<{ message: string }>(`/mfa/enrollments/${encodeURIComponent(enrollmentId)}`, {
    method: 'DELETE',
  });
}

/**
 * Delete a passkey authenticator. Gated by `requireMfa` on the backend; if the
 * current session has no `amr: ["mfa"]` or `amr: ["phr"]` claim, this catches the
 * StepUpRequiredError and redirects through Auth0 with
 * `acr_values=...:multi-factor`. The redirect navigates the page away — the
 * returned promise never resolves on the step-up path.
 */
export async function deletePasskey(
  methodId: string,
  options: { stepUpAction?: string } = {},
): Promise<{ message: string }> {
  try {
    return await apiRequest<{ message: string }>(`/mfa/passkeys/${encodeURIComponent(methodId)}`, {
      method: 'DELETE',
    });
  } catch (err) {
    if (err instanceof StepUpRequiredError) {
      redirectToStepUp(options.stepUpAction ?? 'delete-passkey');
      return new Promise<{ message: string }>(() => {});
    }
    throw err;
  }
}

/**
 * Regenerate the user's MFA recovery code. The backend gates this on the
 * `amr: ["mfa"]` claim in the ID token. When missing, this catches the
 * StepUpRequiredError and redirects through Auth0 with `acr_values=...
 * :multi-factor` so the next attempt passes the gate. The redirect navigates
 * the page away — the returned promise never resolves on the step-up path.
 */
export async function regenerateRecoveryCode(
  options: { stepUpAction?: string } = {},
): Promise<RegenerateRecoveryCodeResponse> {
  try {
    return await apiRequest<RegenerateRecoveryCodeResponse>('/mfa/recovery-code/regenerate', {
      method: 'POST',
    });
  } catch (err) {
    if (err instanceof StepUpRequiredError) {
      redirectToStepUp(options.stepUpAction ?? 'regenerate-recovery-code');
      // Hold the promise — the page is navigating away.
      return new Promise<RegenerateRecoveryCodeResponse>(() => {});
    }
    throw err;
  }
}

// ── Account deletion (FIL-112) ───────────────────────────────────────────

import type {
  DeleteAccountRequest,
  DeleteAccountResponse,
  DeletionChallengeResponse,
} from '@filone/shared';

export const DELETE_ACCOUNT_STEP_UP_ACTION = 'delete-account';

/**
 * Request the account-deletion email verification code. MFA-enrolled users
 * are bounced through the step-up round-trip first (same pattern as
 * deletePasskey) — the redirect navigates the page away, so the returned
 * promise never resolves on that path.
 */
export async function requestDeletionChallenge(): Promise<DeletionChallengeResponse> {
  try {
    return await apiRequest<DeletionChallengeResponse>('/account/delete-challenge', {
      method: 'POST',
    });
  } catch (err) {
    if (err instanceof StepUpRequiredError) {
      redirectToStepUp(DELETE_ACCOUNT_STEP_UP_ACTION);
      return new Promise<DeletionChallengeResponse>(() => {});
    }
    throw err;
  }
}

/** Confirm account deletion with the typed org name and the emailed code. */
export async function deleteAccount(req: DeleteAccountRequest): Promise<DeleteAccountResponse> {
  try {
    return await apiRequest<DeleteAccountResponse>('/account/delete', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  } catch (err) {
    if (err instanceof StepUpRequiredError) {
      redirectToStepUp(DELETE_ACCOUNT_STEP_UP_ACTION);
      return new Promise<DeleteAccountResponse>(() => {});
    }
    throw err;
  }
}

// ── Usage API ────────────────────────────────────────────────────────────

import type { UsageResponse, ActivityResponse } from '@filone/shared';

export function getUsage(): Promise<UsageResponse> {
  return apiRequest<UsageResponse>('/usage');
}

export function getActivity(
  options: { limit?: number; period?: '7d' | '30d' } = {},
): Promise<ActivityResponse> {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', String(options.limit));
  if (options.period) params.set('period', options.period);
  const qs = params.toString();
  return apiRequest<ActivityResponse>(`/activity${qs ? `?${qs}` : ''}`);
}

// ── Billing API ─────────────────────────────────────────────────────────

import type {
  BillingInfo,
  CreateSetupIntentResponse,
  ActivateSubscriptionRequest,
  ActivateSubscriptionResponse,
  CreatePortalSessionResponse,
  ListInvoicesResponse,
} from '@filone/shared';

export function getBilling(): Promise<BillingInfo> {
  return apiRequest<BillingInfo>('/billing');
}

export function createSetupIntent(): Promise<CreateSetupIntentResponse> {
  return apiRequest<CreateSetupIntentResponse>('/billing/setup-intent', { method: 'POST' });
}

export function activateSubscription(
  opts: ActivateSubscriptionRequest = {},
): Promise<ActivateSubscriptionResponse> {
  return apiRequest<ActivateSubscriptionResponse>('/billing/activate', {
    method: 'POST',
    body: JSON.stringify(opts),
  });
}

export function createPortalSession(): Promise<CreatePortalSessionResponse> {
  return apiRequest<CreatePortalSessionResponse>('/billing/portal', { method: 'POST' });
}

export function getInvoices(): Promise<ListInvoicesResponse> {
  return apiRequest<ListInvoicesResponse>('/billing/invoices');
}

// ── Access Keys API ──────────────────────────────────────────────────────────

import type { CreateAccessKeyRequest, CreateAccessKeyResponse } from '@filone/shared';

export function createAccessKey(body: CreateAccessKeyRequest): Promise<CreateAccessKeyResponse> {
  return apiRequest<CreateAccessKeyResponse>('/access-keys', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ── RAG API ──────────────────────────────────────────────────────────────

// The RAG Pipeline client functions live in rag-bucket-api.ts (typed wrappers
// over apiRequest). Re-exported here so call sites can import RAG and core API
// functions from a single module, matching the rest of the API surface.
export {
  listBucketsForRag,
  getBucketRagEnabled,
  setBucketRagEnabled,
  queryBucket,
} from './rag-bucket-api.js';
export { listRagApiKeys, createRagApiKey, deleteRagApiKey } from './rag-api-keys-api.js';
