import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { decodeJwt } from 'jose';
import { OAUTH_STATE_COOKIE, CSRF_COOKIE_NAME } from '@filone/shared';
import { Resource } from 'sst';
import {
  COOKIE_NAMES,
  TOKEN_MAX_AGE,
  makeClearAuthCookies,
  makeCookieHeader,
  makeHintCookieHeader,
  makeClearCookieHeader,
} from '../lib/response-builder.js';
import { parseCookies } from '../lib/cookies.js';
import { getAuthSecrets } from '../lib/auth-secrets.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { resolveOrigin } from '../lib/resolve-origin.js';

function redirect(location: string, cookies: string[] = []): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 302,
    headers: { Location: location },
    body: '',
    ...(cookies.length > 0 && { cookies }),
  };
}

async function baseHandler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const origin = resolveOrigin(event);
  const errorUrl = `${origin}/login-error`;

  const { code, error, error_description, state } = event.queryStringParameters ?? {};

  // Auth0 sends error + error_description if the user denied access or something failed
  if (error ?? !code) {
    const reason = error_description ?? error ?? 'Authentication failed';
    console.error('Auth0 callback error:', { error, error_description });
    return redirect(`${errorUrl}?error=${encodeURIComponent(reason)}`);
  }

  // Validate OAuth state parameter to prevent CSRF on the login flow
  const cookies = parseCookies(event.cookies);
  const storedState = cookies[OAUTH_STATE_COOKIE];
  if (!state || !storedState || state !== storedState) {
    console.error('OAuth state mismatch', { state, storedState: !!storedState });
    return redirect(`${errorUrl}?error=${encodeURIComponent('Invalid state')}`, [
      makeClearCookieHeader(OAUTH_STATE_COOKIE),
    ]);
  }

  const domain = process.env.AUTH0_DOMAIN!;
  const audience = process.env.AUTH0_AUDIENCE!;
  const callbackUrl = `${origin}/api/auth/callback`;
  const secrets = getAuthSecrets();

  const tokenRes = await fetch(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: secrets.AUTH0_CLIENT_ID,
      client_secret: secrets.AUTH0_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl,
      audience,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const errorBody = await tokenRes.text();
    console.error('Auth0 token exchange failed:', { status: tokenRes.status, body: errorBody });
    return redirect(`${errorUrl}?error=${encodeURIComponent('Token exchange failed')}`);
  }

  const { access_token, id_token, refresh_token } = (await tokenRes.json()) as {
    access_token: string;
    id_token: string;
    refresh_token?: string;
  };

  // FIL-112: while teardown is still deleting the Auth0 user, a deleted
  // account's Auth0 SSO session can silently re-authenticate. Never mint
  // session cookies for a tombstoned identity — without this the SPA loops
  // forever: /me returns 401 ACCOUNT_DELETED, the client redirects to /login,
  // SSO re-issues tokens, and the callback lands it back in the app.
  if (await isTombstonedIdentity(id_token)) {
    return redirect(`${origin}/account-deleted`, [
      makeClearCookieHeader(OAUTH_STATE_COOKIE),
      ...makeClearAuthCookies(CSRF_COOKIE_NAME),
    ]);
  }

  const csrfToken = crypto.randomUUID();
  const responseCookies = [
    makeCookieHeader(COOKIE_NAMES.ACCESS_TOKEN, access_token, TOKEN_MAX_AGE.ACCESS),
    makeCookieHeader(COOKIE_NAMES.ID_TOKEN, id_token, TOKEN_MAX_AGE.ACCESS),
    ...(refresh_token
      ? [makeCookieHeader(COOKIE_NAMES.REFRESH_TOKEN, refresh_token, TOKEN_MAX_AGE.REFRESH)]
      : []),
    makeHintCookieHeader(COOKIE_NAMES.LOGGED_IN, '1', TOKEN_MAX_AGE.REFRESH),
    makeHintCookieHeader(CSRF_COOKIE_NAME, csrfToken, TOKEN_MAX_AGE.ACCESS),
    makeClearCookieHeader(OAUTH_STATE_COOKIE),
  ];

  return redirect(`${origin}/dashboard`, responseCookies);
}

/**
 * True when the token's sub maps to a tombstoned (deleted) identity row.
 * The id_token came straight from Auth0's token endpoint over TLS, so a
 * decode without signature verification is safe for this check. Fails open
 * on decode/DynamoDB errors: login must not gain a hard dependency here —
 * the auth middleware's own tombstone gate still backstops this path.
 */
async function isTombstonedIdentity(idToken: string): Promise<boolean> {
  try {
    const sub = decodeJwt(idToken).sub;
    if (!sub) return false;
    const { Item } = await getDynamoClient().send(
      new GetItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: { pk: { S: `SUB#${sub}` }, sk: { S: 'IDENTITY' } },
      }),
    );
    return Item?.deleted?.BOOL === true;
  } catch (err) {
    console.warn('[auth-callback] Tombstone check failed; proceeding with login', { error: err });
    return false;
  }
}

export const handler = middy(baseHandler).use(httpHeaderNormalizer()).use(errorHandlerMiddleware());
