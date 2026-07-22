import { jwtVerify, type createRemoteJWKSet } from 'jose';
import { getAuthSecrets } from './auth-secrets.js';

export interface NewTokens {
  access_token: string;
  id_token: string;
  refresh_token: string;
}

/** Exchange the refresh token at Auth0's token endpoint; null on any failure. */
export async function exchangeRefreshToken(refreshToken: string): Promise<NewTokens | null> {
  const domain = process.env.AUTH0_DOMAIN!;
  const secrets = getAuthSecrets();
  try {
    const res = await fetch(`https://${domain}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: secrets.AUTH0_CLIENT_ID,
        client_secret: secrets.AUTH0_CLIENT_SECRET,
        refresh_token: refreshToken,
      }).toString(),
    });

    if (res.ok) {
      const tokens = (await res.json()) as {
        access_token: string;
        id_token: string;
        refresh_token?: string;
      };
      return {
        access_token: tokens.access_token,
        id_token: tokens.id_token,
        refresh_token: tokens.refresh_token ?? refreshToken,
      };
    }
    const body = await res.text().catch(() => '');
    console.warn('[auth] Token refresh failed', { status: res.status, body });
  } catch (err) {
    console.warn('[auth] Token refresh threw', { error: err });
  }
  return null;
}

/**
 * Exchange the refresh token AND verify the minted access token's signature
 * before its sub is trusted. The exchange response came from Auth0's token
 * endpoint over TLS, but decoded-only claims are never trusted — the same
 * signature gate the auth middleware applies to cookie-supplied tokens. A
 * verification failure is treated like a failed refresh (returns null, no
 * cookies are minted) rather than a 5xx.
 */
export async function exchangeAndVerifyRefreshToken({
  refreshToken,
  jwks,
  audience,
  issuer,
}: {
  refreshToken: string;
  jwks: ReturnType<typeof createRemoteJWKSet>;
  audience: string;
  issuer: string;
}): Promise<{ tokens: NewTokens; sub: string } | null> {
  const tokens = await exchangeRefreshToken(refreshToken);
  if (!tokens) return null;
  try {
    const { payload } = await jwtVerify(tokens.access_token, jwks, { audience, issuer });
    if (!payload.sub) return null;
    return { tokens, sub: payload.sub };
  } catch (err) {
    console.error('[auth] Refreshed access token failed verification', { error: err });
    return null;
  }
}
