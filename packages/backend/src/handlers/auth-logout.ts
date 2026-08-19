import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { CSRF_COOKIE_NAME, logoutReturnTo } from '@filone/shared';
import { getAuthSecrets } from '../lib/auth-secrets.js';
import { COOKIE_NAMES, makeClearCookieHeader } from '../lib/response-builder.js';
import { parseCookies } from '../lib/cookies.js';
import { resolveOrigin } from '../lib/resolve-origin.js';
import { resolveAuth0Domain } from '../lib/auth0-domain.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

async function baseHandler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  // Must be the domain that issued this session, both to revoke the refresh
  // token and to land on a /v2/logout that recognises it.
  const domain = resolveAuth0Domain(event);
  const secrets = getAuthSecrets();

  // Revoke the refresh token at Auth0 before clearing cookies so it cannot
  // be reused after logout. Fire-and-forget: a revocation failure must not
  // block the user from logging out.
  const cookies = parseCookies(event.cookies);
  const refreshToken = cookies[COOKIE_NAMES.REFRESH_TOKEN];
  if (refreshToken) {
    try {
      await fetch(`https://${domain}/oauth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: secrets.AUTH0_CLIENT_ID,
          client_secret: secrets.AUTH0_CLIENT_SECRET,
          token: refreshToken,
        }).toString(),
      });
    } catch (err) {
      console.warn('[logout] Refresh token revocation failed', { error: err });
    }
  }

  const clearCookies = [
    makeClearCookieHeader(COOKIE_NAMES.ACCESS_TOKEN),
    makeClearCookieHeader(COOKIE_NAMES.ID_TOKEN),
    makeClearCookieHeader(COOKIE_NAMES.REFRESH_TOKEN),
    makeClearCookieHeader(COOKIE_NAMES.LOGGED_IN),
    makeClearCookieHeader(CSRF_COOKIE_NAME),
  ];

  // Follows the console host: a production console hands off to its marketing site so
  // signing out of an alias does not land on fil.one, and every other stage returns to
  // itself so you can sign straight back in as someone else.
  const returnTo = logoutReturnTo(resolveOrigin(event));

  const logoutUrl = new URL(`https://${domain}/v2/logout`);
  logoutUrl.searchParams.set('client_id', secrets.AUTH0_CLIENT_ID);
  logoutUrl.searchParams.set('returnTo', returnTo);

  return {
    statusCode: 302,
    headers: { Location: logoutUrl.toString() },
    body: '',
    cookies: clearCookies,
  };
}

export const handler = middy(baseHandler).use(httpHeaderNormalizer()).use(errorHandlerMiddleware());
