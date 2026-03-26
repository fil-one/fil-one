import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { OAUTH_STATE_COOKIE, buildAuth0AuthorizeUrl } from '@filone/shared';
import { getAuthSecrets } from '../lib/auth-secrets.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { resolveOrigin } from '../lib/resolve-origin.js';

async function baseHandler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const origin = resolveOrigin(event);
  const secrets = getAuthSecrets();
  const domain = process.env.AUTH0_DOMAIN!;
  const audience = process.env.AUTH0_AUDIENCE!;

  const state = crypto.randomUUID();
  const { screen_hint, connection } = event.queryStringParameters ?? {};

  const authorizeUrl = buildAuth0AuthorizeUrl({
    domain,
    clientId: secrets.AUTH0_CLIENT_ID,
    audience,
    redirectUri: `${origin}/api/auth/callback`,
    state,
    screenHint: screen_hint === 'signup' ? 'signup' : undefined,
    connection: connection || undefined,
  });

  return {
    statusCode: 302,
    headers: { Location: authorizeUrl },
    body: '',
    cookies: [
      `${OAUTH_STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=300`,
    ],
  };
}

export const handler = middy(baseHandler).use(httpHeaderNormalizer()).use(errorHandlerMiddleware());
