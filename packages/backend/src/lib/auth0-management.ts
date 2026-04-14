import { Resource } from 'sst';

function getDomain(): string {
  return process.env.AUTH0_DOMAIN!;
}

/** Canonical tenant domain for Management API — custom domains don't support /api/v2/. */
function getMgmtDomain(): string {
  return process.env.AUTH0_MGMT_DOMAIN ?? process.env.AUTH0_DOMAIN!;
}

// Module-level token cache — reused across Lambda warm starts.
// Management tokens are not user-specific, so caching is safe.
let cachedMgmtToken: { token: string; expiresAt: number } | null = null;

async function getManagementToken(): Promise<string> {
  const now = Date.now();
  if (cachedMgmtToken && now < cachedMgmtToken.expiresAt) {
    return cachedMgmtToken.token;
  }

  const domain = getMgmtDomain();
  const resp = await fetch(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: Resource.Auth0MgmtRuntimeClientId.value,
      client_secret: Resource.Auth0MgmtRuntimeClientSecret.value,
      audience: `https://${domain}/api/v2/`,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Auth0 management token request failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as { access_token: string; expires_in: number };
  // Cache with 60-second buffer before actual expiry
  cachedMgmtToken = {
    token: data.access_token,
    expiresAt: now + (data.expires_in - 60) * 1000,
  };
  return data.access_token;
}

export async function updateAuth0User(sub: string, data: Record<string, unknown>): Promise<void> {
  const domain = getMgmtDomain();
  const token = await getManagementToken();
  const resp = await fetch(`https://${domain}/api/v2/users/${encodeURIComponent(sub)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Auth0 update user failed (${resp.status}): ${body}`);
  }
}

/**
 * Trigger Auth0 to send a verification email to the user.
 * Requires the `create:user_tickets` scope on the M2M app.
 */
export async function sendVerificationEmail(sub: string): Promise<void> {
  const domain = getMgmtDomain();
  const token = await getManagementToken();
  const resp = await fetch(`https://${domain}/api/v2/jobs/verification-email`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      user_id: sub,
      client_id: Resource.Auth0ClientId.value,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error('[auth0] Failed to send verification email', { status: resp.status, body });
    throw new Error(`Auth0 send verification email failed (${resp.status}): ${body}`);
  }
}

/**
 * Initiate an Auth0 password reset email for a database-connection user.
 */
export async function initiatePasswordReset(email: string, clientId: string): Promise<void> {
  const domain = getDomain();
  const resp = await fetch(`https://${domain}/dbconnections/change_password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      email,
      connection: 'Username-Password-Authentication',
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Auth0 change_password failed (${resp.status}): ${body}`);
  }
}

/**
 * Derive connection type from the Auth0 sub claim prefix.
 * e.g. "auth0|abc123" → "auth0", "google-oauth2|abc" → "google-oauth2"
 */
export function getConnectionType(sub: string): string {
  const pipeIndex = sub.indexOf('|');
  if (pipeIndex === -1) return 'unknown';
  return sub.substring(0, pipeIndex);
}
