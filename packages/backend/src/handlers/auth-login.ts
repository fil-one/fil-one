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
  const { screen_hint, connection, acr_values, max_age } = event.queryStringParameters ?? {};

  const authorizeUrl = buildAuth0AuthorizeUrl({
    domain,
    clientId: secrets.AUTH0_CLIENT_ID,
    audience,
    redirectUri: `${origin}/api/auth/callback`,
    state,
    screenHint: screen_hint === 'signup' ? 'signup' : undefined,
    connection: connection || undefined,
    acrValues: acr_values || undefined,
    maxAge: parseMaxAge(max_age),
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

/**
 * The step-up round trip's `max_age`, as a number Auth0 will honor.
 *
 * `0` is the value the console actually sends, and it is what forces a fresh
 * authentication so the new ID token carries a current `auth_time` — the signal
 * `requireMfaIfEnrolled` reads for a federated user, who never gets an `mfa` in
 * `amr`. Anything that is not a non-negative integer is dropped rather than
 * passed on: a garbage `max_age` would make Auth0 reject the whole authorize
 * request, turning a step-up into a broken login.
 */
function parseMaxAge(value: string | undefined): number | undefined {
  // The empty check is not redundant: `Number('')` is 0, and 0 is precisely the
  // value that means "re-authenticate now", so `?max_age=` would otherwise turn
  // a bare login into a forced one.
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

export const handler = middy(baseHandler).use(httpHeaderNormalizer()).use(errorHandlerMiddleware());
