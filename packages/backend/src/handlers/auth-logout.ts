import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { CSRF_COOKIE_NAME } from '@filone/shared';
import { getAuthSecrets } from '../lib/auth-secrets.js';
import { revokeRefreshToken } from '../lib/auth0-revoke.js';
import { COOKIE_NAMES, makeClearAuthCookies } from '../lib/response-builder.js';
import { parseCookies } from '../lib/cookies.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

async function baseHandler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const domain = process.env.AUTH0_DOMAIN!;
  const secrets = getAuthSecrets();

  // Revoke the refresh token at Auth0 before clearing cookies, so a token already
  // handed out cannot be exchanged for new ones after logout.
  //
  // The failure is swallowed rather than surfaced: the cookies are cleared either
  // way, so the session ends locally regardless, and a 500 here would leave the
  // user apparently logged in with no way to retry. The token expires on its own.
  await revokeRefreshToken(
    parseCookies(event.cookies)[COOKIE_NAMES.REFRESH_TOKEN],
    '[auth-logout]',
  );

  const clearCookies = makeClearAuthCookies(CSRF_COOKIE_NAME);

  const logoutUrl = new URL(`https://${domain}/v2/logout`);
  logoutUrl.searchParams.set('client_id', secrets.AUTH0_CLIENT_ID);
  logoutUrl.searchParams.set('returnTo', 'https://fil.one');

  return {
    statusCode: 302,
    headers: { Location: logoutUrl.toString() },
    body: '',
    cookies: clearCookies,
  };
}

export const handler = middy(baseHandler).use(httpHeaderNormalizer()).use(errorHandlerMiddleware());
