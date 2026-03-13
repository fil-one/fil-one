import type { MiddlewareObj, Request } from '@middy/core';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { GetItemCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import { Resource } from 'sst';
import type { UserInfo } from '../lib/user-context.js';
import { ApiErrorCode, OrgRole } from '@filone/shared';
import type { ErrorResponse } from '@filone/shared';
import {
  COOKIE_NAMES,
  TOKEN_MAX_AGE,
  makeCookieHeader,
  makeHintCookieHeader,
  ResponseBuilder,
} from '../lib/response-builder.js';
import { getAuthSecrets } from '../lib/auth-secrets.js';
import { OrgSetupStatus } from '../lib/org-setup-status.js';
import { getDynamoClient } from '../lib/ddb-client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NewTokens {
  access_token: string;
  id_token: string;
  refresh_token: string;
}

export interface AuthInternal extends Record<string, unknown> {
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
  cachedJWKS = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`));
  return cachedJWKS;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { parseCookies } from '../lib/cookies.js';
import { CSRF_COOKIE_NAME } from '@filone/shared';

function unauthorizedResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder().status(401).body<ErrorResponse>({ message: 'Unauthorized' }).build();
}

function orgNotConfirmedResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(403)
    .body<ErrorResponse>({
      message: 'Please create an organization to continue.',
      code: ApiErrorCode.ORG_NOT_CONFIRMED,
    })
    .build();
}

/**
 * Routes that are allowed through even when the user's org is not yet confirmed.
 * All other authenticated routes will return 403 ORG_NOT_CONFIRMED.
 */
const ORG_CONFIRM_BYPASS_ROUTES = new Set(['/api/me', '/api/org/confirm']);

/**
 * Verify the ID token and extract the email claim.
 * Returns undefined if the token is missing or invalid (non-fatal).
 */
async function extractEmailFromIdToken({
  idToken,
  jwks,
  clientId,
  issuer,
}: {
  idToken: string | undefined;
  jwks: ReturnType<typeof createRemoteJWKSet>;
  clientId: string;
  issuer: string;
}): Promise<string | null> {
  if (!idToken) return null;
  try {
    const { payload } = await jwtVerify(idToken, jwks, { audience: clientId, issuer });
    return (payload.email as string) ?? null;
  } catch (err) {
    console.warn('[auth] ID token verification failed, continuing without email', {
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Resolve user identity from sub+email, attach userInfo to the request context,
 * and enforce the org-confirmed gate.
 * Returns a 403 response if the org is not confirmed and the route is gated,
 * or undefined to let the request continue.
 */
async function attachIdentity({
  event,
  sub,
  email,
}: {
  event: APIGatewayProxyEventV2;
  sub: string;
  email: string | null;
}): Promise<APIGatewayProxyStructuredResultV2 | null> {
  const resolved = await resolveUserAndOrg(sub, email);
  (
    event.requestContext as APIGatewayProxyEventV2['requestContext'] & { userInfo: UserInfo }
  ).userInfo = {
    userId: resolved.userId,
    orgId: resolved.orgId,
    email: resolved.email ?? undefined,
  };
  if (!resolved.orgConfirmed && !ORG_CONFIRM_BYPASS_ROUTES.has(event.rawPath)) {
    return orgNotConfirmedResponse();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sub → userId + orgId resolution via UserInfoTable
// ---------------------------------------------------------------------------

interface ResolvedIdentity {
  userId: string;
  orgId: string;
  orgConfirmed: boolean;
  email: string | null;
}

async function resolveUserAndOrg(sub: string, email: string | null): Promise<ResolvedIdentity> {
  const tableName = Resource.UserInfoTable.name;

  // Look up existing mapping
  const result = await getDynamoClient().send(
    new GetItemCommand({
      TableName: tableName,
      Key: {
        pk: { S: `SUB#${sub}` },
        sk: { S: 'IDENTITY' },
      },
    }),
  );

  // TODO: Improve the org display name (e.g. use the user's organization name from Auth0)
  const orgName = (email && email.split('@')[1]) ?? 'My Organization';

  if (result.Item?.userId?.S && result.Item?.orgId?.S) {
    const userId = result.Item.userId.S;
    const orgId = result.Item.orgId.S;
    // Prefer stored email from identity record, fall back to JWT email
    const resolvedEmail = result.Item.email?.S ?? email;

    const { Item: orgItem } = await getDynamoClient().send(
      new GetItemCommand({
        TableName: tableName,
        Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
      }),
    );

    const orgConfirmed = orgItem?.orgConfirmed?.BOOL === true;

    return { userId, orgId, orgConfirmed, email: resolvedEmail };
  }

  // New user — create user, org, and membership records atomically
  const userId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const now = new Date().toISOString();

  await getDynamoClient().send(
    new TransactWriteItemsCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: { S: `SUB#${sub}` },
              sk: { S: 'IDENTITY' },
              userId: { S: userId },
              orgId: { S: orgId },
              ...(email ? { email: { S: email } } : {}),
              createdAt: { S: now },
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: { S: `USER#${userId}` },
              sk: { S: 'PROFILE' },
              sub: { S: sub },
              orgId: { S: orgId },
              ...(email ? { email: { S: email } } : {}),
              createdAt: { S: now },
            },
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: { S: `ORG#${orgId}` },
              sk: { S: 'PROFILE' },
              name: { S: orgName },
              orgConfirmed: { BOOL: false },
              setupStatus: { S: OrgSetupStatus.FILONE_ORG_CREATED },
              createdBy: { S: userId },
              createdAt: { S: now },
            },
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: { S: `ORG#${orgId}` },
              sk: { S: `MEMBER#${userId}` },
              role: { S: OrgRole.Admin },
              ...(email ? { email: { S: email } } : {}),
              joinedAt: { S: now },
            },
          },
        },
      ],
    }),
  );

  // Do NOT enqueue tenant setup here — org is not yet confirmed.
  // Tenant setup will be triggered when the user confirms their org via POST /api/org/confirm.

  return { userId, orgId, orgConfirmed: false, email };
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------
export function authMiddleware() {
  const before = async (
    request: AuthMiddlewareRequest,
  ): Promise<APIGatewayProxyStructuredResultV2 | void> => {
    const { event } = request;
    const cookies = parseCookies(event.cookies);

    const accessToken = cookies[COOKIE_NAMES.ACCESS_TOKEN];
    const idToken = cookies[COOKIE_NAMES.ID_TOKEN];
    const refreshToken = cookies[COOKIE_NAMES.REFRESH_TOKEN];

    // TODO [Option D]: AUTH0_DOMAIN env var will change to custom domain
    // (e.g. auth.fil.one). JWKS, issuer, and token endpoints use the same domain.
    const domain = process.env.AUTH0_DOMAIN!;
    const audience = process.env.AUTH0_AUDIENCE!;
    const issuer = `https://${domain}/`;
    const secrets = getAuthSecrets();
    const jwks = getJWKS(domain);

    const hasCookies = {
      accessToken: !!accessToken,
      idToken: !!idToken,
      refreshToken: !!refreshToken,
    };
    console.warn('[auth] Starting auth check', { hasCookies });

    // Step 1: Validate existing access token
    if (accessToken) {
      try {
        const { payload } = await jwtVerify(accessToken, jwks, { audience, issuer });
        const sub = payload.sub!;
        const email = await extractEmailFromIdToken({
          idToken,
          jwks,
          clientId: secrets.AUTH0_CLIENT_ID,
          issuer,
        });
        const blocked = await attachIdentity({ event, sub, email });
        if (blocked) return blocked;
        return; // Valid — continue to handler
      } catch (err) {
        // Expired or invalid — fall through to refresh
        console.warn('[auth] Access token verification failed', { error: (err as Error).message });
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
          const refreshedPayload = decodeJwt(tokens.access_token);
          const refreshedSub = refreshedPayload.sub!;
          const refreshedEmail = await extractEmailFromIdToken({
            idToken: tokens.id_token,
            jwks,
            clientId: secrets.AUTH0_CLIENT_ID,
            issuer,
          });
          console.warn('[auth] Token refresh succeeded');
          const blocked = await attachIdentity({ event, sub: refreshedSub, email: refreshedEmail });
          if (blocked) return blocked;
          return; // Continue to handler
        }
        const refreshBody = await tokenRes.text().catch(() => '');
        console.warn('[auth] Token refresh failed', { status: tokenRes.status, body: refreshBody });
      } catch (err) {
        // Refresh failed — fall through
        console.warn('[auth] Token refresh threw', { error: (err as Error).message });
      }
    }

    console.warn('[auth] Returning 401 — no valid tokens');
    return unauthorizedResponse();
  };

  const after = async (request: AuthMiddlewareRequest): Promise<void> => {
    const { newTokens } = request.internal;
    // Narrow to structured result — the string form has no cookies field
    const response = request.response as APIGatewayProxyStructuredResultV2 | undefined;
    if (!newTokens || !response) return;

    const csrfToken = crypto.randomUUID();
    response.cookies = [
      ...(response.cookies ?? []),
      makeCookieHeader(COOKIE_NAMES.ACCESS_TOKEN, newTokens.access_token, TOKEN_MAX_AGE.ACCESS),
      makeCookieHeader(COOKIE_NAMES.ID_TOKEN, newTokens.id_token, TOKEN_MAX_AGE.ACCESS),
      makeCookieHeader(COOKIE_NAMES.REFRESH_TOKEN, newTokens.refresh_token, TOKEN_MAX_AGE.REFRESH),
      makeHintCookieHeader(COOKIE_NAMES.LOGGED_IN, '1', TOKEN_MAX_AGE.REFRESH),
      makeHintCookieHeader(CSRF_COOKIE_NAME, csrfToken, TOKEN_MAX_AGE.ACCESS),
    ];
  };

  return { before, after } satisfies MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2>;
}
