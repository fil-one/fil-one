import type { MiddlewareObj, Request } from '@middy/core';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import { Resource } from 'sst';
import type { AuthenticatedEvent, UserInfo } from '../lib/user-context.js';
import { ApiErrorCode } from '@filone/shared';
import type { ErrorResponse } from '@filone/shared';
import {
  accountDeletedResponse,
  COOKIE_NAMES,
  TOKEN_MAX_AGE,
  makeCookieHeader,
  makeHintCookieHeader,
  ResponseBuilder,
} from '../lib/response-builder.js';
import { getAuthSecrets } from '../lib/auth-secrets.js';
import { resolveAuth0Domain } from '../lib/auth0-domain.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { createNewUserAndOrg, stampVerifiedEmail } from '../lib/account-creation.js';
import { resolveMembership } from '../lib/org-membership.js';
import type { OrgMembership } from '../lib/org-membership.js';
import { deriveOrgName } from '../lib/suggest-org-name.js';
import { enforceIdentityProvider, resolveActiveOrg } from './org-context.js';

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
  /**
   * Verified ID token claims, set by the before hook after `jwtVerify`.
   * Defaulted (with `amr: []`) when the id_token cookie is missing or
   * verification fails — downstream gates on `amr` see an empty list and
   * fail closed. Read via `getVerifiedIdTokenClaims`.
   */
  idTokenClaims?: IdTokenClaims;
}

type AuthMiddlewareRequest = Request<
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Error,
  Context,
  AuthInternal
>;

/**
 * Read verified ID token claims stashed by `authMiddleware`. Returns the
 * empty-claims default (with `amr: []`) when the auth middleware ran but
 * no valid id_token cookie was present, so callers can read fields without
 * null checks.
 *
 * Must only be called from middleware/handlers downstream of `authMiddleware`.
 */
export function getVerifiedIdTokenClaims(
  request: Request<APIGatewayProxyEventV2, APIGatewayProxyResultV2, Error, Context>,
): IdTokenClaims {
  return (request.internal as AuthInternal).idTokenClaims ?? EMPTY_ID_CLAIMS;
}

// ---------------------------------------------------------------------------
// Module-level JWKS cache — reused across Lambda warm starts
// ---------------------------------------------------------------------------

// Keyed by domain: the console is served from hostnames that authenticate against
// different Auth0 domains, so a single cached set would hand the first caller's
// JWKS to every later request no matter which domain it asked for.
const jwksByDomain = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJWKS(domain: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksByDomain.get(domain);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`));
  jwksByDomain.set(domain, jwks);
  return jwks;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { parseCookies } from '../lib/cookies.js';
import { CSRF_COOKIE_NAME } from '@filone/shared';
import { AccountDeletedError, isIdentityTombstoned } from '../lib/identity-tombstone.js';
import { isOrgDeleting } from '../lib/org-profile.js';

function unauthorizedResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder().status(401).body<ErrorResponse>({ message: 'Unauthorized' }).build();
}

function emailNotVerifiedResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(403)
    .body<ErrorResponse>({
      message: 'Email verification required',
      code: ApiErrorCode.EMAIL_NOT_VERIFIED,
    })
    .build();
}

/**
 * The caller authenticated, but OrgTable would not say what they may do. A
 * retryable failure of ours, so it is a 503 rather than a 401 that would send
 * the console through a pointless refresh, or a 403 that would read as a
 * revoked membership.
 *
 * Exported for the RAG bearer path, which resolves the key creator's membership
 * itself and owes a failed read the same answer this one gives.
 */
export function membershipUnavailableResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(503)
    .body<ErrorResponse>({
      message: 'We could not read your organization membership. Please try again in a moment.',
    })
    .build();
}

/**
 * Exchange a refresh token for fresh access/id/refresh tokens.
 * Returns null if the refresh fails for any reason.
 *
 * `domain` must be the Auth0 domain that issued the refresh token — the request's
 * domain, not the stage's configured one — or the exchange is rejected.
 */
async function exchangeRefreshToken(
  refreshToken: string,
  domain: string,
): Promise<NewTokens | null> {
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

export interface IdTokenClaims {
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  /** OIDC Authentication Methods References — empty when not asserted/verified. */
  amr: string[];
  /**
   * When the user last authenticated at the identity provider (`auth_time`,
   * epoch seconds), or null when the token asserts none.
   *
   * Read alongside `amr` because `amr` alone cannot express step-up for a
   * federated user: a SAML session never carries `mfa` or `phr` and Guardian
   * holds no enrollment for it, so "authenticated moments ago at your own
   * identity provider" is the only strong signal available. A step-up redirect
   * asks for it with `max_age=0`.
   */
  authTime: number | null;
  /**
   * The Auth0 organization this session authenticated into (`org_id`), null for
   * a session that named none — which is every session in M1, since nothing
   * sends the `organization` parameter yet. It is read now because the rule that
   * consumes it is about what a session may reach: an org carrying an
   * `auth0OrgId` is enterable only from a session authenticated at that org.
   */
  auth0OrgId: string | null;
}

const EMPTY_ID_CLAIMS: IdTokenClaims = {
  email: null,
  emailVerified: false,
  name: null,
  picture: null,
  amr: [],
  authTime: null,
  auth0OrgId: null,
};

/**
 * Verify the ID token and extract claims. Returns defaults (including
 * `amr: []`) if the token is missing or invalid — callers gating on `amr`
 * see an empty array, which fails their check just like a verified token
 * without `amr` would.
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
  if (!idToken) return EMPTY_ID_CLAIMS;
  try {
    const { payload } = await jwtVerify(idToken, jwks, { audience: clientId, issuer });
    const rawAmr = payload.amr;
    return {
      email: (payload.email as string) ?? null,
      emailVerified: (payload.email_verified as boolean) ?? false,
      name: (payload.name as string) ?? null,
      picture: (payload.picture as string) ?? null,
      amr: Array.isArray(rawAmr) ? rawAmr.filter((v): v is string => typeof v === 'string') : [],
      authTime: typeof payload.auth_time === 'number' ? payload.auth_time : null,
      auth0OrgId: typeof payload.org_id === 'string' ? payload.org_id : null,
    };
  } catch (err) {
    console.warn(
      '[auth] ID token verification failed, continuing without verified ID token claims',
      {
        error: err,
      },
    );
    return EMPTY_ID_CLAIMS;
  }
}

/**
 * Hosts that only ever serve Auth0/Gravatar's own generated placeholder — a
 * colored circle with the caller's initials — rather than a photo anyone
 * actually chose.
 *
 * The `auth0` (database/passwordless) connection's `picture` claim is always
 * `https://s.gravatar.com/avatar/<hash>?...&d=<default>`: Gravatar serves a
 * registered photo for that hash if one exists, and otherwise redirects to
 * the `d=` default, which Auth0 points at its own generated avatar on
 * `cdn.auth0.com`. There is no registered-photo case on `cdn.auth0.com`
 * itself (that host is only ever the generated fallback), and a genuinely
 * chosen Gravatar photo is vanishingly unlikely for this product's accounts —
 * so both are treated the same way: not a real picture. Real provider photos
 * (`lh3.googleusercontent.com`, `avatars.githubusercontent.com`) and this
 * console's own uploaded avatars (a distinct S3 domain, see
 * `avatar-storage.ts`) are untouched.
 */
const GENERATED_AVATAR_HOSTS = new Set(['s.gravatar.com', 'cdn.auth0.com']);

/** Whether `picture` is one of Auth0/Gravatar's own generated placeholders. */
function isGeneratedAvatar(picture: string): boolean {
  try {
    return GENERATED_AVATAR_HOSTS.has(new URL(picture).hostname);
  } catch {
    // Not a URL at all — pass it through rather than guess.
    return false;
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
  const resolved = await resolveUserAndOrg(sub, email, emailVerified, name);
  (
    event.requestContext as APIGatewayProxyEventV2['requestContext'] & { userInfo: UserInfo }
  ).userInfo = {
    sub,
    userId: resolved.userId,
    orgId: resolved.orgId,
    email: resolved.email ?? undefined,
    emailVerified,
    name: name ?? undefined,
    picture: picture && !isGeneratedAvatar(picture) ? picture : undefined,
    // Set only when this request created the account: the signup transaction
    // wrote the row, so re-reading it would be a race against its own write.
    ...(resolved.membership ? { membership: resolved.membership } : {}),
  };
}

/**
 * Resolve the caller's membership in the active org, once authentication has
 * succeeded.
 *
 * Its own step, outside token validation's catch-all: an OrgTable outage is not
 * a bad token, and reading it as one costs the caller a 401 plus a refresh they
 * did not need. One more GetItem in a middleware that already makes one —
 * reading the role per request rather than carrying it in the token is what
 * makes a role change take effect on the next request, with no invalidation
 * machinery.
 *
 * An absent row is left absent. The conversion has backfilled every account, so
 * absence now means the caller is not a member, and `authorize` turns it into a
 * 403 — while `/api/me`, which carries no role gate, still answers with no role
 * and an empty permission set so the console can say so.
 *
 * Returns a response when the read fails, and undefined when it succeeds.
 *
 * `fallbackOrgId` is `/api/me`'s escape hatch, and only its. When the header
 * named an org the caller turns out not to be a member of, the active org falls
 * back to their own and the response echoes the org that was actually resolved.
 * Every other route answers a stale stashed org with the ordinary 403, which
 * sends the console to `/me`; if `/me` answered that 403 too, the one surface
 * that can clear the stash would be the one surface the stash locks out.
 */
async function attachMembership(
  event: APIGatewayProxyEventV2,
  fallbackOrgId?: string,
): Promise<APIGatewayProxyStructuredResultV2 | undefined> {
  const userInfo = (
    event.requestContext as APIGatewayProxyEventV2['requestContext'] & { userInfo: UserInfo }
  ).userInfo;
  if (userInfo.membership) return undefined;

  try {
    userInfo.membership = await resolveMembership(userInfo.orgId, userInfo.userId);
    if (userInfo.membership || fallbackOrgId === undefined || userInfo.orgId === fallbackOrgId) {
      return undefined;
    }

    console.warn('[auth] The org header named an org the caller is not in — using their own', {
      requestedOrgId: userInfo.orgId,
      orgId: fallbackOrgId,
      userId: userInfo.userId,
    });
    userInfo.orgId = fallbackOrgId;
    userInfo.membership = await resolveMembership(fallbackOrgId, userInfo.userId);
    return undefined;
  } catch (err) {
    console.error('[auth] OrgTable membership read failed — cannot resolve the role', {
      orgId: userInfo.orgId,
      userId: userInfo.userId,
      error: err,
    });
    return membershipUnavailableResponse();
  }
}

// ---------------------------------------------------------------------------
// Sub → userId + orgId resolution via UserInfoTable
// ---------------------------------------------------------------------------

interface ResolvedIdentity {
  userId: string;
  orgId: string;
  email: string | null;
  /** Present only on the signup branch, which just wrote the membership row. */
  membership?: OrgMembership;
}

async function resolveUserAndOrg(
  sub: string,
  email: string | null,
  emailVerified: boolean,
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

  // Before the userId/orgId branch, so a stamped row can never be read as a new signup.
  if (isIdentityTombstoned(result.Item)) throw new AccountDeletedError();

  if (result.Item?.userId?.S && result.Item?.orgId?.S) {
    const userId = result.Item.userId.S;
    const orgId = result.Item.orgId.S;

    // The session fence. On the org profile, so the confirm transaction stays three
    // items at any org size. Ahead of the backfill: a deleted org must not trigger it.
    if (await isOrgDeleting(orgId)) throw new AccountDeletedError();

    if (!email) {
      console.error(
        '[auth] Existing user authenticated without email claim — ID token verification may have failed',
        { userId },
      );
    }
    // The profile's address and name are the org paths' only copy of them, and
    // accounts created before they were stamped have neither. Gated on the
    // markers this row already carries, so a profile that is current costs no
    // write.
    await stampVerifiedEmail({
      sub,
      userId,
      email,
      emailVerified,
      name,
      stampedEmail: result.Item.profileEmail?.S,
      stampedName: result.Item.profileName?.S,
    });
    return { userId, orgId, email };
  }

  // New user — create user, org, and membership records atomically.
  const userId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const orgName = deriveOrgName(name ?? undefined, email ?? undefined);

  const membership = await createNewUserAndOrg({
    sub,
    userId,
    orgId,
    orgName,
    // Verified only: the audit viewer shows this as the member's identity, and
    // an unverified claim names whoever typed it.
    email: emailVerified ? (email ?? undefined) : undefined,
    // No verified gate on the name: the roster shows it and it decides nothing.
    name: name ?? undefined,
  });

  // Tenant setup is deferred until the user creates their first bucket or access
  // key — see docs/architectural-decisions/2026-05-13-synchronous-tenant-setup-on-first-resource.md.
  //
  // The trial is NOT claimed here. Login is the wrong place for it once a user
  // can belong to more than one org: the subscription guard is the only claim
  // point (ADR §4/§5), it runs on the first gated request in the caller's own
  // org, and it is the only code that can tell that org from somebody else's.
  // Claiming on the login path would spend an invitee's entitlement the moment
  // they signed in, which is the thing the guard's conditions exist to prevent.
  // For an organic signup the claim now happens one request later, on the
  // dashboard's first API call, with the same Stripe latency.

  return { userId, orgId, email, membership };
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

async function tryValidateAccessToken({
  request,
  accessToken,
  idToken,
  jwks,
  audience,
  issuer,
  clientId,
  failureLabel,
}: {
  request: AuthMiddlewareRequest;
  accessToken: string;
  idToken: string | undefined;
  jwks: ReturnType<typeof createRemoteJWKSet>;
  audience: string;
  issuer: string;
  clientId: string;
  failureLabel: string;
}): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(accessToken, jwks, { audience, issuer });
    const sub = payload.sub!;
    const idClaims = await extractIdTokenClaims({ idToken, jwks, clientId, issuer });
    request.internal.idTokenClaims = idClaims;
    await attachIdentity({
      event: request.event,
      sub,
      email: idClaims.email,
      emailVerified: idClaims.emailVerified,
      name: idClaims.name,
      picture: idClaims.picture,
    });
    return true;
  } catch (err) {
    // A tombstoned identity is a decision, not a validation failure — it must
    // not be downgraded to "try the next token path".
    if (err instanceof AccountDeletedError) throw err;
    console.warn(failureLabel, { error: err });
    return false;
  }
}

export interface AuthMiddlewareOptions {
  /**
   * Require the user's email to be verified (`email_verified` ID token claim).
   * Defaults to true so new endpoints are protected unless they explicitly
   * opt out — only endpoints serving the verification flow itself (e.g.
   * `get-me`, `resend-verification`) should set this to false.
   */
  requireVerifiedEmail?: boolean;
  /**
   * Serve the caller from their own org when the request's `X-Org-Id` names one
   * they are not a member of, instead of letting the absent row become a 403.
   *
   * `GET /api/me` alone sets this. The console keeps the active org per tab, so
   * a membership revoked or an org deleted since the stash was written must not
   * be able to refuse the request whose answer is what clears the stash.
   */
  orgHeaderFallback?: boolean;
}

/**
 * Enforce the verified-email gate after authentication succeeds, before the
 * handler runs. Reads the claims stashed by the auth path that just
 * succeeded; the empty-claims default (emailVerified: false) fails closed.
 */
function verifiedEmailGate(
  requireVerifiedEmail: boolean,
  request: AuthMiddlewareRequest,
): APIGatewayProxyStructuredResultV2 | undefined {
  if (!requireVerifiedEmail) return undefined;
  const claims = request.internal.idTokenClaims ?? EMPTY_ID_CLAIMS;
  return claims.emailVerified ? undefined : emailNotVerifiedResponse();
}

/**
 * Carry the rotated cookies on a response the before hook returns itself.
 *
 * Every gate that runs after this middleware in the same before stack owes its
 * denials this call — `authorize`, the membership gate, CSRF, the subscription
 * guard, the RAG access gate, the MFA gate. Returning a response from `before`
 * short-circuits the whole chain, the after hook included (@middy/core 7.2.2
 * runs the after stack only when the request carries no `earlyResponse`), so a
 * refresh that already happened has to set its own cookies here. Otherwise the
 * caller's old refresh token is spent at Auth0 and the new one never reaches
 * them — one denial becomes a logout on every tab.
 *
 * Takes the plain request type and reads `internal` through {@link AuthInternal},
 * the same way `getVerifiedIdTokenClaims` does, so a middleware downstream of
 * this one can call it without restating the internal shape.
 */
export function withRefreshedCookies(
  request: Request<APIGatewayProxyEventV2, APIGatewayProxyResultV2, Error, Context>,
  response: APIGatewayProxyStructuredResultV2,
): APIGatewayProxyStructuredResultV2 {
  const { newTokens } = request.internal as AuthInternal;
  if (newTokens) setCookiesFromTokens(response, newTokens);
  return response;
}

/**
 * The caller's standing in the org the request resolved to: their membership,
 * then the org's identity-provider rule.
 *
 * The order is the security property. Membership decides whether the caller may
 * be in this org at all, and only a member costs the org's profile a read — so
 * naming an org id the caller is not in answers the same 403 whether or not that
 * org authenticates through its own provider.
 *
 * `fallbackOrgId` is `/api/me`'s escape hatch and only its: when the org the
 * header named refuses this session, the answer degrades to the caller's own org
 * rather than refusing, because that answer is what tells the console its
 * stashed org is stale. Enforcement then applies to the org fallen back to, so a
 * session locked out of its own SSO org still gets the 403 — that is the rule
 * working, and re-authenticating through the org's provider is the way in.
 */
async function resolveOrgStanding(
  event: AuthenticatedEvent,
  sessionAuth0OrgId: string | null,
  fallbackOrgId: string | undefined,
): Promise<APIGatewayProxyStructuredResultV2 | undefined> {
  const membershipFailure = await attachMembership(event, fallbackOrgId);
  if (membershipFailure) return membershipFailure;

  const { userInfo } = event.requestContext;
  // No membership, no standing to rule on: `authorize` refuses the request, and
  // reading the org's profile for a caller who is not in it would answer
  // "does this org use SSO?" to anyone who names one.
  if (!userInfo.membership) return undefined;

  const refusal = await enforceIdentityProvider(userInfo.orgId, sessionAuth0OrgId);
  if (!refusal || fallbackOrgId === undefined || userInfo.orgId === fallbackOrgId) return refusal;

  console.warn('[auth] The org header named an org this session may not enter — using their own', {
    requestedOrgId: userInfo.orgId,
    orgId: fallbackOrgId,
    userId: userInfo.userId,
  });
  userInfo.orgId = fallbackOrgId;
  delete userInfo.membership;
  return resolveOrgStanding(event, sessionAuth0OrgId, fallbackOrgId);
}

/**
 * What runs after a token proves the caller's identity, on both the
 * access-token and the refresh branch: the verified-email gate, then the active
 * org, then the caller's standing in it. Identical on both so a failure cannot
 * depend on which branch authenticated the request.
 */
async function completeAuthentication(
  request: AuthMiddlewareRequest,
  { requireVerifiedEmail = true, orgHeaderFallback = false }: AuthMiddlewareOptions,
): Promise<APIGatewayProxyStructuredResultV2 | undefined> {
  const gated = verifiedEmailGate(requireVerifiedEmail, request);
  if (gated) return withRefreshedCookies(request, gated);

  const event = request.event as AuthenticatedEvent;
  const claims = request.internal.idTokenClaims ?? EMPTY_ID_CLAIMS;

  const activeOrg = resolveActiveOrg(event);
  if (activeOrg.response) {
    // A header that is not an org id is a client error everywhere but `/me`,
    // which answers under the caller's own org instead: its echo is what tells
    // the console to drop the value that produced this.
    if (!orgHeaderFallback) return withRefreshedCookies(request, activeOrg.response);
    console.warn('[auth] Ignoring a malformed org header on /me — using the caller’s own org', {
      orgId: event.requestContext.userInfo.orgId,
    });
  }

  const refusal = await resolveOrgStanding(
    event,
    claims.auth0OrgId,
    orgHeaderFallback ? activeOrg.personalOrgId : undefined,
  );
  return refusal ? withRefreshedCookies(request, refusal) : undefined;
}

// eslint-disable-next-line max-lines-per-function
export function authMiddleware(options: AuthMiddlewareOptions = {}) {
  // Mapped once here rather than at each attachIdentity call site, so no token
  // path can turn a deleted account into a 401 and invite a retry.
  const before = async (
    request: AuthMiddlewareRequest,
  ): Promise<APIGatewayProxyStructuredResultV2 | void> => {
    try {
      return await authenticate(request);
    } catch (err) {
      if (err instanceof AccountDeletedError) return accountDeletedResponse();
      throw err;
    }
  };

  const authenticate = async (
    request: AuthMiddlewareRequest,
  ): Promise<APIGatewayProxyStructuredResultV2 | void> => {
    const { event } = request;
    const cookies = parseCookies(event.cookies);

    const accessToken = cookies[COOKIE_NAMES.ACCESS_TOKEN];
    const idToken = cookies[COOKIE_NAMES.ID_TOKEN];
    const refreshToken = cookies[COOKIE_NAMES.REFRESH_TOKEN];

    // Derived from the request host, not the stage config: the alias hostnames
    // authenticate against a different Auth0 domain, and `iss` plus the JWKS
    // endpoint both have to match whichever domain minted these cookies.
    const domain = resolveAuth0Domain(event);
    const audience = process.env.AUTH0_AUDIENCE!;
    const issuer = `https://${domain}/`;
    const secrets = getAuthSecrets();
    const jwks = getJWKS(domain);

    // Stash refresh token so the after hook can force-refresh if a handler requests it
    if (refreshToken) {
      request.internal.refreshToken = refreshToken;
    }

    const forceRefresh = event.queryStringParameters?.forceRefresh === '1';
    const validateArgs = {
      request,
      idToken,
      jwks,
      audience,
      issuer,
      clientId: secrets.AUTH0_CLIENT_ID,
    };

    // Step 1: Validate existing access token (skip if forceRefresh — we need fresh claims)
    if (accessToken && !forceRefresh) {
      const ok = await tryValidateAccessToken({
        ...validateArgs,
        accessToken,
        failureLabel: '[auth] Access token verification failed',
      });
      if (ok) return completeAuthentication(request, options);
    }

    // Step 2: Attempt token refresh (always runs when forceRefresh=1)
    if (refreshToken) {
      const tokens = await exchangeRefreshToken(refreshToken, domain);
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
        request.internal.idTokenClaims = refreshedClaims;
        await attachIdentity({
          event,
          sub: refreshedSub,
          email: refreshedClaims.email,
          emailVerified: refreshedClaims.emailVerified,
          name: refreshedClaims.name,
          picture: refreshedClaims.picture,
        });
        return completeAuthentication(request, options);
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
      const ok = await tryValidateAccessToken({
        ...validateArgs,
        accessToken,
        failureLabel: '[auth] Fallback access token validation failed',
      });
      if (ok) return completeAuthentication(request, options);
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
      const refreshed = await exchangeRefreshToken(
        request.internal.refreshToken,
        resolveAuth0Domain(event),
      );
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
