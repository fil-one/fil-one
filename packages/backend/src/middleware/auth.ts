import type { MiddlewareObj, Request } from '@middy/core';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { ErrorResponse } from '@hyperspace/shared';
import { COOKIE_NAMES, TOKEN_MAX_AGE, makeCookieHeader, makeHintCookieHeader, ResponseBuilder } from '../lib/response-builder.js';
import { getEnv } from '../lib/env.js';
import { getAuthSecrets } from '../lib/auth-secrets.js';

// ---------------------------------------------------------------------------
// Scopes — extend this enum as new handlers are added. Pass the required
// scopes to authMiddleware() at each handler's middy definition.
// ---------------------------------------------------------------------------
export enum Scope {
  UploadWrite = 'upload:write',
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NewTokens {
  access_token: string;
  id_token: string;
  refresh_token: string;
}

interface AuthInternal extends Record<string, unknown> {
  newTokens?: NewTokens;
}

type AuthMiddlewareRequest = Request<
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Error,
  Context,
  AuthInternal
>;

// ---------------------------------------------------------------------------
// Module-level JWKS cache — reused across Lambda warm starts
// ---------------------------------------------------------------------------

let cachedJWKS: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJWKS(domain: string): ReturnType<typeof createRemoteJWKSet> {
  if (cachedJWKS) return cachedJWKS;
  cachedJWKS = createRemoteJWKSet(
    new URL(`https://${domain}/.well-known/jwks.json`),
  );
  return cachedJWKS;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCookies(cookieHeader: string): Record<string, string> {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader.split(';').flatMap((part) => {
      const eqIdx = part.indexOf('=');
      if (eqIdx === -1) return [];
      return [[part.slice(0, eqIdx).trim(), part.slice(eqIdx + 1).trim()]];
    }),
  );
}

function unauthorizedResponse(): APIGatewayProxyResultV2 {
  return new ResponseBuilder()
    .status(401)
    .body<ErrorResponse>({ message: 'Unauthorized' })
    .build();
}

function forbiddenResponse(): APIGatewayProxyResultV2 {
  return new ResponseBuilder()
    .status(403)
    .body<ErrorResponse>({ message: 'Forbidden: insufficient permissions for this API' })
    .build();
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export function authMiddleware(
  requiredScopes: Scope[],
): MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2> {
  const before = async (
    request: AuthMiddlewareRequest,
  ): Promise<APIGatewayProxyResultV2 | void> => {
    const { event } = request;
    // Headers are lowercased by httpHeaderNormalizer
    const cookies = parseCookies(event.headers['cookie'] ?? '');

    const accessToken = cookies[COOKIE_NAMES.ACCESS_TOKEN];
    const idToken = cookies[COOKIE_NAMES.ID_TOKEN];
    const refreshToken = cookies[COOKIE_NAMES.REFRESH_TOKEN];

    // TODO [Option D]: AUTH0_DOMAIN env var will change to custom domain
    // (e.g. auth.filhyperspace.com). JWKS, issuer, and token endpoints use the same domain.
    const domain = getEnv('AUTH0_DOMAIN');
    const audience = getEnv('AUTH0_AUDIENCE');
    const issuer = `https://${domain}/`;
    const secrets = await getAuthSecrets();
    const jwks = getJWKS(domain);

    // Step 1: Validate existing access token
    if (accessToken) {
      try {
        const { payload } = await jwtVerify(accessToken, jwks, { audience, issuer });
        const tokenScopes = ((payload['scope'] as string | undefined) ?? '').split(' ');
        const hasAllScopes = requiredScopes.every((s) => tokenScopes.includes(s));
        if (!hasAllScopes) throw new Error('Missing required scope(s)');
        return; // Valid — continue to handler
      } catch {
        // Expired or insufficient — fall through to refresh
      }
    }

    // Step 2: Attempt token refresh
    if (refreshToken) {
      try {
        const tokenRes = await fetch(`https://${domain}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: secrets.AUTH0_CLIENT_ID,
            client_secret: secrets.AUTH0_CLIENT_SECRET,
            refresh_token: refreshToken,
          }).toString(),
        });

        if (tokenRes.ok) {
          const tokens = (await tokenRes.json()) as {
            access_token: string;
            id_token: string;
            refresh_token?: string;
          };
          // Stash new tokens — the after hook attaches them as Set-Cookie headers
          request.internal.newTokens = {
            access_token: tokens.access_token,
            id_token: tokens.id_token,
            // Use the rotated token if Auth0 returned one, otherwise reuse the old one
            refresh_token: tokens.refresh_token ?? refreshToken,
          } satisfies NewTokens;
          return; // Continue to handler
        }
      } catch {
        // Refresh failed — fall through
      }
    }

    // Step 3: Cannot obtain a valid access token.
    // Check if the id_token is still valid to distinguish 403 from 401.
    if (idToken) {
      try {
        // id_token audience is the Auth0 client ID, not the API audience
        await jwtVerify(idToken, jwks, {
          audience: secrets.AUTH0_CLIENT_ID,
          issuer,
        });
        // Authenticated identity, but cannot access this API → 403
        return forbiddenResponse();
      } catch {
        // id_token also invalid — fall through to 401
      }
    }

    return unauthorizedResponse();
  };

  const after = async (request: AuthMiddlewareRequest): Promise<void> => {
    const { newTokens } = request.internal;
    // Narrow to structured result — the string form has no cookies field
    const response = request.response as APIGatewayProxyStructuredResultV2 | undefined;
    if (!newTokens || !response) return;

    response.cookies = [
      ...(response.cookies ?? []),
      makeCookieHeader(COOKIE_NAMES.ACCESS_TOKEN, newTokens.access_token, TOKEN_MAX_AGE.ACCESS),
      makeCookieHeader(COOKIE_NAMES.ID_TOKEN, newTokens.id_token, TOKEN_MAX_AGE.ACCESS),
      makeCookieHeader(COOKIE_NAMES.REFRESH_TOKEN, newTokens.refresh_token, TOKEN_MAX_AGE.REFRESH),
      makeHintCookieHeader(COOKIE_NAMES.LOGGED_IN, '1', TOKEN_MAX_AGE.REFRESH),
    ];
  };

  return { before, after };
}
