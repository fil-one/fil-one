import { Resource } from 'sst';

function getDomain(): string {
  return process.env.AUTH0_DOMAIN!;
}

async function getManagementToken(): Promise<string> {
  const domain = getDomain();
  const resp = await fetch(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: Resource.Auth0MgmtClientId.value,
      client_secret: Resource.Auth0MgmtClientSecret.value,
      audience: `https://${domain}/api/v2/`,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Auth0 management token request failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as { access_token: string };
  return data.access_token;
}

export async function updateAuth0User(sub: string, data: Record<string, unknown>): Promise<void> {
  const domain = getDomain();
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
  const domain = getDomain();
  const token = await getManagementToken();
  const resp = await fetch(`https://${domain}/api/v2/jobs/verification-email`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      user_id: sub,
      client_id: Resource.Auth0MgmtClientId.value,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error('[auth0] Failed to send verification email', { status: resp.status, body });
  }
}

export async function deleteAuth0User(sub: string): Promise<void> {
  const domain = getDomain();
  const token = await getManagementToken();
  const resp = await fetch(`https://${domain}/api/v2/users/${encodeURIComponent(sub)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Auth0 delete user failed (${resp.status}): ${body}`);
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
