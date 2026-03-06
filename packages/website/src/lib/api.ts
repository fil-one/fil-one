import { API_URL, AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_AUDIENCE } from '../env.js';
import { OAUTH_STATE_COOKIE, CSRF_COOKIE_NAME } from '@hyperspace/shared';

// Prevents multiple simultaneous 401 responses from each triggering a redirect.
let isRedirecting = false;

function getCsrfToken(): string | undefined {
  return document.cookie
    .split('; ')
    .find(c => c.startsWith(`${CSRF_COOKIE_NAME}=`))
    ?.split('=')[1];
}

interface LoginOptions {
  loginHint?: string;
  screenHint?: 'signup';
  /** Auth0 connection name (e.g. 'google-oauth2', 'github') to skip Universal Login and go directly to a social provider. */
  connection?: string;
}

// TODO [Option D]: When we move to a custom domain (e.g. auth.filhyperspace.com),
// AUTH0_DOMAIN will change to the custom domain. No code changes needed here —
// just update the VITE_AUTH0_DOMAIN env var.
function buildAuth0LoginUrl(options?: LoginOptions): string {
  const callbackUrl = `${window.location.origin}/api/auth/callback`;
  const state = crypto.randomUUID();
  document.cookie = `${OAUTH_STATE_COOKIE}=${state}; Secure; SameSite=Lax; Path=/; Max-Age=300`;
  const params = new URLSearchParams({
    client_id: AUTH0_CLIENT_ID,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: 'openid profile email offline_access',
    audience: AUTH0_AUDIENCE,
    state,
  });
  if (options?.loginHint) params.set('login_hint', options.loginHint);
  if (options?.screenHint) params.set('screen_hint', options.screenHint);
  if (options?.connection) params.set('connection', options.connection);
  return `https://${AUTH0_DOMAIN}/authorize?${params.toString()}`;
}

export function redirectToLogin(options?: LoginOptions): void {
  if (isRedirecting) return;
  isRedirecting = true;
  window.location.href = buildAuth0LoginUrl(options);
}

export function logout(): void {
  window.location.href = `${API_URL}/api/auth/logout`;
}

/**
 * Wrapper around fetch for all Hyperspace API calls.
 * - Always sends HttpOnly auth cookies via credentials: 'include'
 * - Redirects to Auth0 login on 401
 */
export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
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
    throw new Error('Session expired. Redirecting to login...');
  }

  if (response.status === 403) {
    const body = await response.json().catch(() => ({})) as { message?: string; code?: string };
    if (body.code === 'GRACE_PERIOD_WRITE_BLOCKED') {
      throw new Error('Your account is in a grace period. Read-only access is available. Please reactivate your subscription to make changes.');
    }
    if (body.code === 'SUBSCRIPTION_CANCELED') {
      throw new Error('Your subscription has been canceled. Please reactivate to regain access.');
    }
    throw new Error(body.message ?? 'Access denied');
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(error.message ?? `Request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

// ── Billing API ─────────────────────────────────────────────────────────

import type {
  BillingInfo,
  CreateSetupIntentResponse,
  ActivateSubscriptionResponse,
  CreatePortalSessionResponse,
} from '@hyperspace/shared';

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
