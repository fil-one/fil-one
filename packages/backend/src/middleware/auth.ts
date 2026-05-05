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
import { OrgRole } from '@filone/shared';
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
import { deriveOrgName } from '../lib/suggest-org-name.js';
import { triggerTenantSetup } from '../lib/trigger-tenant-setup.js';
import { createBillingTrial } from '../lib/create-billing-trial.js';

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
  /** Stashed by the before hook so the after hook can force-refresh if needed. */
  refreshToken?: string;
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

/**
 * Exchange a refresh token for fresh access/id/refresh tokens.
 * Returns null if the refresh fails for any reason.
 */
async function exchangeRefreshToken(refreshToken: string): Promise<NewTokens | null> {
  const domain = process.env.AUTH0_DOMAIN!;
  const secrets = getAuthSecrets();
  try {
    const res = await fetch(`https://${domain}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: secrets.AUTH0_CLIENT_ID,
        client_secret: secrets.AUTH0_CLIENT_SECRET,
        refresh_token: refreshToken,
      }).toString(),
    });

    if (res.ok) {
      const tokens = (await res.json()) as {
        access_token: string;
        id_token: string;
        refresh_token?: string;
      };
      return {
        access_token: tokens.access_token,
        id_token: tokens.id_token,
        refresh_token: tokens.refresh_token ?? refreshToken,
      };
    }
    const body = await res.text().catch(() => '');
    console.warn('[auth] Token refresh failed', { status: res.status, body });
  } catch (err) {
    console.warn('[auth] Token refresh threw', { error: err });
  }
  return null;
}

function setCookiesFromTokens(
  response: APIGatewayProxyStructuredResultV2,
  tokens: NewTokens,
): void {
  const csrfToken = crypto.randomUUID();
  response.cookies = [
    ...(response.cookies ?? []),
    makeCookieHeader(COOKIE_NAMES.ACCESS_TOKEN, tokens.access_token, TOKEN_MAX_AGE.ACCESS),
    makeCookieHeader(COOKIE_NAMES.ID_TOKEN, tokens.id_token, TOKEN_MAX_AGE.ACCESS),
    makeCookieHeader(COOKIE_NAMES.REFRESH_TOKEN, tokens.refresh_token, TOKEN_MAX_AGE.REFRESH),
    makeHintCookieHeader(COOKIE_NAMES.LOGGED_IN, '1', TOKEN_MAX_AGE.REFRESH),
    makeHintCookieHeader(CSRF_COOKIE_NAME, csrfToken, TOKEN_MAX_AGE.ACCESS),
  ];
}

interface IdTokenClaims {
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

/**
 * Verify the ID token and extract email + email_verified claims.
 * Returns defaults if the token is missing or invalid (non-fatal).
 */
async function extractIdTokenClaims({
  idToken,
  jwks,
  clientId,
  issuer,
}: {
  idToken: string | undefined;
  jwks: ReturnType<typeof createRemoteJWKSet>;
  clientId: string;
  issuer: string;
}): Promise<IdTokenClaims> {
  if (!idToken) return { email: null, emailVerified: false, name: null, picture: null };
  try {
    const { payload } = await jwtVerify(idToken, jwks, { audience: clientId, issuer });
    return {
      email: (payload.email as string) ?? null,
      emailVerified: (payload.email_verified as boolean) ?? false,
      name: (payload.name as string) ?? null,
      picture: (payload.picture as string) ?? null,
    };
  } catch (err) {
    console.warn('[auth] ID token verification failed, continuing without email', { error: err });
    return { email: null, emailVerified: false, name: null, picture: null };
  }
}

/**
 * Resolve user identity from sub+email and attach userInfo to the request context.
 */
async function attachIdentity({
  event,
  sub,
  email,
  emailVerified,
  name,
  picture,
}: {
  event: APIGatewayProxyEventV2;
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}): Promise<void> {
  const resolved = await resolveUserAndOrg(sub, email, name);
  (
    event.requestContext as APIGatewayProxyEventV2['requestContext'] & { userInfo: UserInfo }
  ).userInfo = {
    sub,
    userId: resolved.userId,
    orgId: resolved.orgId,
    email: resolved.email ?? undefined,
    emailVerified,
    name: name ?? undefined,
    picture: picture ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Sub → userId + orgId resolution via UserInfoTable
// ---------------------------------------------------------------------------

interface ResolvedIdentity {
  userId: string;
  orgId: string;
  email: string | null;
}

/**
 * Run the SQS enqueue and Stripe call for a freshly created org in parallel —
 * both are external network calls with no ordering dependency. Failures are
 * logged but never propagated; the /me self-heal path retries tenant setup,
 * and createBillingTrial is idempotent on subsequent attempts via its DDB
 * conditional put.
 */
async function kickoffNewOrgSetup(args: {
  userId: string;
  orgId: string;
  orgName: string;
  email: string | null;
}): Promise<void> {
  const { userId, orgId, orgName, email } = args;
  const [tenantResult, billingResult] = await Promise.allSettled([
    triggerTenantSetup({ orgId, orgName }),
    createBillingTrial({ userId, orgId, email: email ?? undefined }),
  ]);
  if (tenantResult.status === 'rejected') {
    console.error('[auth] Failed to trigger tenant setup for new org', {
      error: tenantResult.reason,
      orgId,
    });
  }
  if (billingResult.status === 'rejected') {
    console.error('[auth] Failed to create billing trial for new org', {
      error: billingResult.reason,
      orgId,
      userId,
    });
  }
}

async function resolveUserAndOrg(
  sub: string,
  email: string | null,
  name: string | null,
): Promise<ResolvedIdentity> {
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

  if (result.Item?.userId?.S && result.Item?.orgId?.S) {
    const userId = result.Item.userId.S;
    const orgId = result.Item.orgId.S;
    if (!email) {
      console.error(
        '[auth] Existing user authenticated without email claim — ID token verification may have failed',
        { userId },
      );
    }
    return { userId, orgId, email };
  }

  // New user — create user, org, and membership records atomically
  const userId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const orgName = deriveOrgName(name ?? undefined, email ?? undefined);
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
              // Retained only so the legacy self-heal path in /me can detect older
              // unconfirmed rows. New rows are always written confirmed=true.
              orgConfirmed: { BOOL: true },
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
              joinedAt: { S: now },
            },
          },
        },
      ],
    }),
  );

  await kickoffNewOrgSetup({ userId, orgId, orgName, email });

  return { userId, orgId, email };
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------
// eslint-disable-next-line max-lines-per-function
export function authMiddleware() {
  const before = async (
    request: AuthMiddlewareRequest,
  ): Promise<APIGatewayProxyStructuredResultV2 | void> => {
    const { event } = request;
    const cookies = parseCookies(event.cookies);

    const accessToken = cookies[COOKIE_NAMES.ACCESS_TOKEN];
    const idToken = cookies[COOKIE_NAMES.ID_TOKEN];
    const refreshToken = cookies[COOKIE_NAMES.REFRESH_TOKEN];

    const domain = process.env.AUTH0_DOMAIN!;
    const audience = process.env.AUTH0_AUDIENCE!;
    const issuer = `https://${domain}/`;
    const secrets = getAuthSecrets();
    const jwks = getJWKS(domain);

    // Stash refresh token so the after hook can force-refresh if a handler requests it
    if (refreshToken) {
      request.internal.refreshToken = refreshToken;
    }

    const forceRefresh = event.queryStringParameters?.forceRefresh === '1';

    // Step 1: Validate existing access token (skip if forceRefresh — we need fresh claims)
    if (accessToken && !forceRefresh) {
      try {
        const { payload } = await jwtVerify(accessToken, jwks, { audience, issuer });
        const sub = payload.sub!;
        const idClaims = await extractIdTokenClaims({
          idToken,
          jwks,
          clientId: secrets.AUTH0_CLIENT_ID,
          issuer,
        });
        await attachIdentity({
          event,
          sub,
          email: idClaims.email,
          emailVerified: idClaims.emailVerified,
          name: idClaims.name,
          picture: idClaims.picture,
        });
        return; // Valid — continue to handler
      } catch (err) {
        // Expired or invalid — fall through to refresh
        console.warn('[auth] Access token verification failed', { error: err });
      }
    }

    // Step 2: Attempt token refresh (always runs when forceRefresh=1)
    if (refreshToken) {
      const tokens = await exchangeRefreshToken(refreshToken);
      if (tokens) {
        request.internal.newTokens = tokens;
        request.internal.refreshToken = tokens.refresh_token;
        const refreshedPayload = decodeJwt(tokens.access_token);
        const refreshedSub = refreshedPayload.sub!;
        const refreshedClaims = await extractIdTokenClaims({
          idToken: tokens.id_token,
          jwks,
          clientId: secrets.AUTH0_CLIENT_ID,
          issuer,
        });
        await attachIdentity({
          event,
          sub: refreshedSub,
          email: refreshedClaims.email,
          emailVerified: refreshedClaims.emailVerified,
          name: refreshedClaims.name,
          picture: refreshedClaims.picture,
        });
        return; // Continue to handler
      }
      if (forceRefresh) {
        console.error(
          '[auth] forceRefresh requested but token exchange failed, falling back to existing access token',
        );
      }
    } else if (forceRefresh) {
      console.error(
        '[auth] forceRefresh requested but no refresh token present, falling back to existing access token',
      );
    }

    // Fallback: when forceRefresh fails (no refresh token or exchange error), try the existing
    // access token rather than returning 401 — this prevents social-provider misconfigurations
    // or transient refresh failures from locking out users in prod.
    if (forceRefresh && accessToken) {
      try {
        const { payload } = await jwtVerify(accessToken, jwks, { audience, issuer });
        const sub = payload.sub!;
        const idClaims = await extractIdTokenClaims({
          idToken,
          jwks,
          clientId: secrets.AUTH0_CLIENT_ID,
          issuer,
        });
        await attachIdentity({
          event,
          sub,
          email: idClaims.email,
          emailVerified: idClaims.emailVerified,
          name: idClaims.name,
          picture: idClaims.picture,
        });
        return;
      } catch (err) {
        console.warn('[auth] Fallback access token validation failed', { error: err });
      }
    }

    console.warn('[auth] Returning 401 — no valid tokens');
    return unauthorizedResponse();
  };

  const after = async (request: AuthMiddlewareRequest): Promise<void> => {
    const { event } = request;
    let { newTokens } = request.internal;
    const response = request.response as APIGatewayProxyStructuredResultV2 | undefined;
    if (!response) return;

    // If a handler called requestTokenRefresh() and we don't already have fresh tokens,
    // perform a refresh so the response includes updated ID token claims.
    const forceRefresh = (
      event.requestContext as APIGatewayProxyEventV2['requestContext'] & {
        _forceTokenRefresh?: boolean;
      }
    )._forceTokenRefresh;

    if (forceRefresh && request.internal.refreshToken) {
      const refreshed = await exchangeRefreshToken(request.internal.refreshToken);
      if (refreshed) {
        newTokens = refreshed;
        console.warn('[auth] Force token refresh succeeded');
      }
    }

    if (newTokens) {
      setCookiesFromTokens(response, newTokens);
    }
  };

  return { before, after } satisfies MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2>;
}
