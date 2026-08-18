import { API_URL } from '../env.js';
import { ApiErrorCode, CSRF_COOKIE_NAME, ORG_ID_HEADER } from '@filone/shared';
import type { StepUpRequiredResponse } from '@filone/shared';
import {
  clearActiveOrgAfterRefusal,
  clearActiveOrgOnNavigation,
  getActiveOrgId,
  reconcileActiveOrg,
  waitWhileSwitching,
} from './active-org.js';
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

/**
 * The caller's role does not carry what the request needed.
 *
 * A subclass rather than a decorated Error because this is the one 403 a
 * component may want to act on: the UI hides what will be refused, so seeing
 * this means the two disagreed — a role changed under an open tab, or a control
 * was left ungated. Either way the fix is to reload `/me`, not to retry.
 */
export class ForbiddenRoleError extends Error {
  readonly status = 403;
  readonly code = ApiErrorCode.FORBIDDEN_ROLE;
  constructor(message?: string) {
    super(message ?? 'Your role in this organization does not permit this action.');
  }
}

/**
 * The caller is not a member of the org they are operating in — the membership
 * was revoked, or the conversion never wrote their row. Distinct from
 * {@link ForbiddenRoleError} because the states have different fixes: one is
 * "ask an Owner for a higher role", the other is "you are not in this org".
 */
export class NotAMemberError extends Error {
  readonly status = 403;
  readonly code = ApiErrorCode.NOT_A_MEMBER;
  constructor(message?: string) {
    super(message ?? 'You are not a member of this organization.');
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

/**
 * Log out, and drop the org this tab was operating in once the logout
 * navigation commits.
 *
 * `sessionStorage` belongs to the tab, not the session, so a shared machine
 * needs the clear; it waits for the navigation because the click may not become
 * one. See `clearActiveOrgOnNavigation`.
 */
export function logout(): void {
  clearActiveOrgOnNavigation();
  window.location.href = `${API_URL}/logout`;
}

/** The bare identity probe. `/me/profile` and friends are ordinary endpoints. */
function isSessionProbe(path: string): boolean {
  return path === '/me' || path.startsWith('/me?');
}

/**
 * Always throws; 410 is in query-client's NO_RETRY_STATUSES so it is not
 * retried. Navigates only when the
 * *session probe* is what reported it, so a 410 arriving mid-action surfaces as
 * an error on that action rather than yanking the page out from under it; the
 * next probe redirects.
 *
 * Not /login — the Auth0 SSO session would silently re-authenticate the deleted
 * identity and loop.
 */
function throwAccountDeleted(status: number, fromSessionProbe: boolean): never {
  if (fromSessionProbe && !isRedirecting) {
    isRedirecting = true;
    window.location.href = '/account-deleted';
  }
  throw Object.assign(new Error('This account has been deleted.'), {
    status,
    code: ApiErrorCode.ACCOUNT_DELETED,
  });
}

/**
 * The error a 403 becomes. Every denial the API can send is named here so a
 * caller renders intent rather than a generic toast, and the two role codes get
 * types a component can branch on.
 */
function forbidden(body: { message?: string; code?: string }): Error {
  switch (body.code) {
    case ApiErrorCode.EMAIL_NOT_VERIFIED:
      if (!isRedirecting) {
        isRedirecting = true;
        window.location.href = '/verify-email';
      }
      return Object.assign(new Error('Email verification required'), { status: 403 });

    case ApiErrorCode.NOT_A_MEMBER:
      return new NotAMemberError(body.message);

    case ApiErrorCode.FORBIDDEN_ROLE:
      return new ForbiddenRoleError(body.message);

    case ApiErrorCode.GRACE_PERIOD_WRITE_BLOCKED:
      return Object.assign(
        new Error(
          'Your account is in a grace period. Read-only access is available. Please reactivate your subscription to make changes.',
        ),
        { status: 403 },
      );

    case ApiErrorCode.SUBSCRIPTION_CANCELED:
      return Object.assign(
        new Error('Your subscription has been canceled. Please reactivate to regain access.'),
        { status: 403 },
      );

    // The org's billing, not the caller's: the message the server sends already
    // names who can set it up, so it is passed through rather than replaced by
    // the account-holder wording the other billing codes carry.
    case ApiErrorCode.ORG_BILLING_INACTIVE:
      return Object.assign(
        new Error(
          body.message ??
            'This organization does not have billing set up. An Owner of the organization can add a payment method.',
        ),
        { status: 403 },
      );

    default:
      return Object.assign(new Error(body.message ?? 'Access denied'), { status: 403 });
  }
}

/**
 * Wrapper around fetch for all Fil.one API calls.
 * - Always sends HttpOnly auth cookies via credentials: 'include'
 * - Redirects to Auth0 login on 401
 */
// eslint-disable-next-line complexity/complexity
export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  // The tab is on its way to another org. Held rather than rejected, for the
  // reason `getMe` returns instead of throwing on a mismatch: the page is
  // disappearing, and an error rendered over it would be the last thing the user
  // sees of the org they just left. A switch that never navigates rolls back
  // instead, and the request goes ahead below against the restored stash.
  await waitWhileSwitching();

  const method = options.method?.toUpperCase() ?? 'GET';
  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const token = getCsrfToken();
    if (token) headers.set('X-CSRF-Token', token);
  }
  // Every call names the org it is about. Without the header the server serves
  // the caller's own org, which is right on a first visit and wrong for anyone
  // who has switched — so the header goes on here, in the one funnel, rather
  // than at each call site.
  const activeOrgId = getActiveOrgId();
  if (activeOrgId) headers.set(ORG_ID_HEADER, activeOrgId);

  const response = await fetch(`${API_URL}/api${path}`, {
    ...options,
    credentials: 'include',
    headers,
  });

  // Checked ahead of the status branches: the backend emits this code as 410,
  // and 410 also carries an expired deletion code, so status alone cannot
  // identify it. `clone()` leaves the body unread for the branches below.
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
    throw forbidden(body);
  }

  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      message?: string;
      code?: ApiErrorCode;
      resendAvailableAt?: string;
    };
    // Carry the backend's error code through so callers can render specific copy
    // (e.g. BUCKET_NOT_EMPTY), or honour a server-set cooldown (the deletion 429
    // carries resendAvailableAt).
    throw Object.assign(
      new Error(error.message ?? `Request failed with status ${response.status}`),
      {
        status: response.status,
        ...(error.code && { code: error.code }),
        ...(error.resendAvailableAt && { resendAvailableAt: error.resendAvailableAt }),
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
  ConfirmAccountDeletionResponse,
  DeleteAccountRequest,
  MeResponse,
  RegenerateRecoveryCodeResponse,
  RequestAccountDeletionResponse,
  UpdateOrgRequest,
  UpdateOrgResponse,
  UpdateProfileRequest,
  UpdateProfileResponse,
} from '@filone/shared';

/**
 * The caller, their role, and the org the server resolved the request in.
 *
 * `/me` is the one response that echoes the active org, and this is where that
 * echo is checked: a mismatch against the tab's stash means every other request
 * is landing in an org the user did not choose, so the stash is cleared and the
 * tab reloads. The response is still returned — the reload is already in flight,
 * and a caller left holding a rejected promise would render an error page over
 * a page that is about to disappear.
 *
 * A refusal carries no echo, and the server degrades `/me` rather than refusing
 * it for anything the header could be at fault for. What is left is `/me`
 * failing on its own account, and a stash held through it is worth dropping
 * once: the alternative is a tab that keeps naming an org nobody will answer for.
 */
export async function getMe(options?: {
  forceRefresh?: boolean;
  include?: 'mfa';
}): Promise<MeResponse> {
  const params = new URLSearchParams();
  if (options?.forceRefresh) params.set('forceRefresh', '1');
  if (options?.include) params.set('include', options.include);
  const qs = params.toString();
  let me: MeResponse;
  try {
    me = await apiRequest<MeResponse>(`/me${qs ? `?${qs}` : ''}`);
  } catch (err) {
    // The status decides: only a refusal the header can be blamed for drops the
    // stash. A network error carries none at all.
    clearActiveOrgAfterRefusal((err as { status?: number }).status);
    throw err;
  }
  reconcileActiveOrg(me.orgId);
  return me;
}

export function updateProfile(data: UpdateProfileRequest): Promise<UpdateProfileResponse> {
  return apiRequest<UpdateProfileResponse>('/me/profile', {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

/**
 * Rename the organization. Its own endpoint because it is its own permission —
 * `org.rename`, which Member and ReadOnly do not hold — while the profile call
 * above changes only the caller's own account.
 */
export function updateOrg(data: UpdateOrgRequest): Promise<UpdateOrgResponse> {
  return apiRequest<UpdateOrgResponse>('/org', {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

// ── Account deletion ────────────────────────────────────────────────────

/**
 * Emails a verification code to the signed-in admin. Answers
 * `deletion_in_progress` instead when the deletion is already confirmed.
 */
export function requestAccountDeletion(): Promise<RequestAccountDeletionResponse> {
  return apiRequest<RequestAccountDeletionResponse>('/account/deletion', { method: 'POST' });
}

/** Terminal: there is no undo, no grace period and no cancel endpoint. */
export function confirmAccountDeletion(
  data: DeleteAccountRequest,
): Promise<ConfirmAccountDeletionResponse> {
  return apiRequest<ConfirmAccountDeletionResponse>('/account/deletion/confirm', {
    method: 'POST',
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

// ── Usage API ────────────────────────────────────────────────────────────

import type { UsageResponse, RecentActivityResponse, UsageTrendsResponse } from '@filone/shared';

export function getUsage(): Promise<UsageResponse> {
  return apiRequest<UsageResponse>('/usage');
}

export function getUsageTrends(period: '7d' | '30d'): Promise<UsageTrendsResponse> {
  return apiRequest<UsageTrendsResponse>(`/usage/trends?period=${period}`);
}

export function getActivity(options: { limit?: number } = {}): Promise<RecentActivityResponse> {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', String(options.limit));
  const qs = params.toString();
  return apiRequest<RecentActivityResponse>(`/activity${qs ? `?${qs}` : ''}`);
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
