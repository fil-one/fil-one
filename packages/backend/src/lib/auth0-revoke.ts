import { getAuthSecrets } from './auth-secrets.js';

/**
 * Revoke a refresh token at Auth0's `/oauth/revoke`.
 *
 * Lives outside auth0-management.ts on purpose: this endpoint authenticates
 * with the *application* client id/secret against `AUTH0_DOMAIN`, whereas
 * auth0-management.ts is built around the M2M management token and
 * `AUTH0_MGMT_DOMAIN` — importing it would drag the management-token code into
 * the logout lambda's bundle.
 *
 * Best-effort: a revocation failure is logged under `logPrefix` and swallowed
 * so it can never block a logout or an account deletion.
 */
export async function revokeRefreshToken(
  refreshToken: string | undefined,
  logPrefix: string,
): Promise<void> {
  if (!refreshToken) return;
  const secrets = getAuthSecrets();
  try {
    await fetch(`https://${process.env.AUTH0_DOMAIN!}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: secrets.AUTH0_CLIENT_ID,
        client_secret: secrets.AUTH0_CLIENT_SECRET,
        token: refreshToken,
      }).toString(),
    });
  } catch (err) {
    console.warn(`${logPrefix} Refresh token revocation failed`, { error: err });
  }
}
