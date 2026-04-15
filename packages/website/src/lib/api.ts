import { API_URL } from '../env.js';
import { ApiErrorCode, CSRF_COOKIE_NAME } from '@filone/shared';

// Prevents multiple simultaneous 401 responses from each triggering a redirect.
let isRedirecting = false;

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
 * Wrapper around fetch for all Fil.one API calls.
 * - Always sends HttpOnly auth cookies via credentials: 'include'
 * - Redirects to Auth0 login on 401
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

  if (response.status === 401) {
    redirectToLogin();
    // Throw so the caller's promise chain stops — the page is navigating away
    throw Object.assign(new Error('Session expired. Redirecting to login...'), { status: 401 });
  }

  if (response.status === 403) {
    const body = (await response.json().catch(() => ({}))) as { message?: string; code?: string };
    if (body.code === ApiErrorCode.ORG_NOT_CONFIRMED) {
      window.dispatchEvent(new CustomEvent('org:not-confirmed'));
      throw Object.assign(new Error('Please create an organization to continue.'), { status: 403 });
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
    const error = (await response.json().catch(() => ({}))) as { message?: string };
    throw Object.assign(
      new Error(error.message ?? `Request failed with status ${response.status}`),
      { status: response.status },
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
  ConfirmOrgResponse,
  UpdateProfileRequest,
  UpdateProfileResponse,
} from '@filone/shared';

export function getMe(options?: { forceRefresh?: boolean }): Promise<MeResponse> {
  const qs = options?.forceRefresh ? '?forceRefresh=1' : '';
  return apiRequest<MeResponse>(`/me${qs}`);
}

export function confirmOrg(orgName: string): Promise<ConfirmOrgResponse> {
  return apiRequest<ConfirmOrgResponse>('/org/confirm', {
    method: 'POST',
    body: JSON.stringify({ orgName }),
  });
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

export function activateSubscription(): Promise<ActivateSubscriptionResponse> {
  return apiRequest<ActivateSubscriptionResponse>('/billing/activate', { method: 'POST' });
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
