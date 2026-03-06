import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { CSRF_COOKIE_NAME } from '@hyperspace/shared';
import { getAuthSecrets } from '../lib/auth-secrets.js';
import { COOKIE_NAMES, makeClearCookieHeader } from '../lib/response-builder.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { resolveOrigin } from '../lib/resolve-origin.js';

async function baseHandler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const origin = resolveOrigin(event);
  const domain = process.env.AUTH0_DOMAIN!;
  const secrets = getAuthSecrets();

  const cookies = [
    makeClearCookieHeader(COOKIE_NAMES.ACCESS_TOKEN),
    makeClearCookieHeader(COOKIE_NAMES.ID_TOKEN),
    makeClearCookieHeader(COOKIE_NAMES.REFRESH_TOKEN),
    makeClearCookieHeader(COOKIE_NAMES.LOGGED_IN),
    makeClearCookieHeader(CSRF_COOKIE_NAME),
  ];

  const logoutUrl = new URL(`https://${domain}/v2/logout`);
  logoutUrl.searchParams.set('client_id', secrets.AUTH0_CLIENT_ID);
  logoutUrl.searchParams.set('returnTo', `${origin}/sign-in`);

  return {
    statusCode: 302,
    headers: { Location: logoutUrl.toString() },
    body: '',
    cookies,
  };
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(errorHandlerMiddleware());
