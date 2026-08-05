import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { OAUTH_STATE_COOKIE, buildAuth0AuthorizeUrl } from '@filone/shared';
import { getAuthSecrets } from '../lib/auth-secrets.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { resolveOrigin } from '../lib/resolve-origin.js';
import { resolveAuth0Domain } from '../lib/auth0-domain.js';

async function baseHandler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const origin = resolveOrigin(event);
  const secrets = getAuthSecrets();
  // Matches the console host: the alias hostnames authenticate against a
  // different Auth0 domain, and the callback must come back to the same one.
  const domain = resolveAuth0Domain(event);
  const audience = process.env.AUTH0_AUDIENCE!;

  const state = crypto.randomUUID();
  const { screen_hint, connection, acr_values } = event.queryStringParameters ?? {};

  const authorizeUrl = buildAuth0AuthorizeUrl({
    domain,
    clientId: secrets.AUTH0_CLIENT_ID,
    audience,
    redirectUri: `${origin}/api/auth/callback`,
    state,
    screenHint: screen_hint === 'signup' ? 'signup' : undefined,
    connection: connection || undefined,
    acrValues: acr_values || undefined,
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
