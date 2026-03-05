import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { COOKIE_NAMES, TOKEN_MAX_AGE, makeCookieHeader, makeHintCookieHeader } from '../lib/response-builder.js';
import { getAuthSecrets } from '../lib/auth-secrets.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

// TODO: Implement state parameter validation to prevent CSRF attacks.
// Before redirecting to Auth0, generate a random state value, store it in a
// short-lived cookie, and verify it matches the state returned here.

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
  const websiteUrl = process.env.WEBSITE_URL!;
  const signInUrl = `${websiteUrl}/sign-in`;

  const { code, error, error_description } = event.queryStringParameters ?? {};

  // Auth0 sends error + error_description if the user denied access or something failed
  if (error ?? !code) {
    const reason = error_description ?? error ?? 'Authentication failed';
    console.error('Auth0 callback error:', { error, error_description });
    return redirect(`${signInUrl}?error=${encodeURIComponent(reason)}`);
  }

  const domain = process.env.AUTH0_DOMAIN!;
  const audience = process.env.AUTH0_AUDIENCE!;
  const callbackUrl = process.env.AUTH_CALLBACK_URL!;
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
    return redirect(`${signInUrl}?error=${encodeURIComponent('Token exchange failed')}`);
  }

  const { access_token, id_token, refresh_token } = (await tokenRes.json()) as {
    access_token: string;
    id_token: string;
    refresh_token?: string;
  };

  const cookies = [
    makeCookieHeader(COOKIE_NAMES.ACCESS_TOKEN, access_token, TOKEN_MAX_AGE.ACCESS),
    makeCookieHeader(COOKIE_NAMES.ID_TOKEN, id_token, TOKEN_MAX_AGE.ACCESS),
    ...(refresh_token
      ? [makeCookieHeader(COOKIE_NAMES.REFRESH_TOKEN, refresh_token, TOKEN_MAX_AGE.REFRESH)]
      : []),
    makeHintCookieHeader(COOKIE_NAMES.LOGGED_IN, '1', TOKEN_MAX_AGE.REFRESH),
  ];

  return redirect(`${websiteUrl}/dashboard`, cookies);
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(errorHandlerMiddleware());
