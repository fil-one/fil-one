import { Resource } from 'sst';

/**
 * Fetch a Management API access token for the given Auth0 tenant. Shared by
 * the setup-integrations orchestration and the extracted setup-passkey job so
 * both can run with the sibling `(domain)` signature.
 */
export async function getAuth0ManagementToken(domain: string): Promise<string> {
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
