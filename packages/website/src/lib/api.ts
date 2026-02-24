import { API_URL, AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_AUDIENCE } from '../env.js';

// Prevents multiple simultaneous 401 responses from each triggering a redirect.
let isRedirecting = false;

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
  const params = new URLSearchParams({
    client_id: AUTH0_CLIENT_ID,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: 'openid profile email offline_access',
    audience: AUTH0_AUDIENCE,
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
  const response = await fetch(`${API_URL}/api${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (response.status === 401) {
    redirectToLogin();
    // Throw so the caller's promise chain stops — the page is navigating away
    throw new Error('Session expired. Redirecting to login...');
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(error.message ?? `Request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}
