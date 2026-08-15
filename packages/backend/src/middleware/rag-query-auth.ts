import type { MiddlewareObj, Request } from '@middy/core';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { S3Region } from '@filone/shared';
import type { ErrorResponse, Permission } from '@filone/shared';
import { isOrgDeleting } from '../lib/org-profile.js';
import { accountDeletedResponse, ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent, UserInfo } from '../lib/user-context.js';
import { findRagKeyByToken, ragKeyAllowsBucket, touchRagKeyLastUsed } from '../lib/rag-api-keys.js';
import { resolveMembership } from '../lib/org-membership.js';
import { authMiddleware, withRefreshedCookies } from './auth.js';
import type { AuthInternal, AuthMiddlewareOptions } from './auth.js';
import { requireMembership, requirePermission } from './authorize.js';

/**
 * Auth dispatcher for the RAG query endpoint: cookie session OR RAG API key.
 *
 * The presence of an `authorization` header selects the bearer path
 * EXCLUSIVELY — a malformed or unknown token is a hard 401, never a silent
 * fall-back to cookies. Without the header, the request is delegated
 * unchanged to the cookie {@link authMiddleware} (the console never sends an
 * Authorization header, so browser behavior is unaffected).
 *
 * On bearer success this attaches a synthetic `userInfo` built from the key
 * record — orgId ALWAYS comes from the stored record, never from the request —
 * so the downstream chain (subscriptionGuard billing the creator,
 * ragAccessMiddleware re-checking the creator's email against the allowlist,
 * and the handler's isSupportedRegion / tenant-scoped bucket lookup) keeps
 * enforcing exactly as it does for cookie callers. Revoking the creator's
 * allowlist entry or subscription therefore disables their keys immediately.
 *
 * The two callers are authorized differently, as the route manifest declares.
 * The bearer token carries its own authority, and what it needs from the org is
 * that its creator is still in it: this path reads the creator's membership
 * itself — the cookie middleware it bypassed would have — and refuses the
 * request when the row is gone, so a removed member's keys die with their
 * membership instead of outliving it. A caller arriving with a cookie session
 * is an ordinary console user and is gated on the manifest's `cookieRequires`.
 */

interface RagQueryAuthInternal extends AuthInternal {
  /** Set when the cookie path handled the request, so only then does the cookie after-hook (token refresh) run. */
  usedCookieAuth?: boolean;
}

type QueryAuthRequest = Request<
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Error,
  Context,
  RagQueryAuthInternal
>;

/** Scheme is case-insensitive (RFC 9110); the token itself is case-sensitive. */
const BEARER_HEADER_PATTERN = /^bearer\s+(\S+)$/i;
const RAG_TOKEN_PATTERN = /^sk_rag_[A-Za-z0-9_-]{20,}$/;

function unauthorizedResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder().status(401).body<ErrorResponse>({ message: 'Unauthorized' }).build();
}

/**
 * Out-of-scope buckets return the same 404 the handler returns for buckets the
 * org does not own, so a key holder cannot distinguish "exists but outside my
 * scope" from "does not exist" (no bucket-name enumeration oracle).
 */
function bucketNotFoundResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(404)
    .body<ErrorResponse>({ message: 'Bucket not found' })
    .build();
}

async function bearerAuth(
  request: QueryAuthRequest,
  authHeader: string,
): Promise<APIGatewayProxyStructuredResultV2 | undefined> {
  const { event } = request;

  const match = BEARER_HEADER_PATTERN.exec(authHeader.trim());
  const token = match?.[1];
  if (!token || !RAG_TOKEN_PATTERN.test(token)) return unauthorizedResponse();

  const record = await findRagKeyByToken(token);
  if (!record) return unauthorizedResponse();

  // A RAG key is a standalone credential with no session behind it, so the
  // SUB# tombstone that kills cookie auth never applies to it.
  if (await isOrgDeleting(record.orgId, { consistent: true })) return accountDeletedResponse();

  // Same region resolution as the handler (query-bucket defaults to eu-west-1)
  // so the scope comparison and the handler can never disagree. Unsupported
  // region values fall through to the handler's isSupportedRegion 400.
  const bucketName = event.pathParameters?.name;
  const region = event.queryStringParameters?.region ?? S3Region.EuWest1;

  // Only enforce bucket scope for known regions; otherwise let the handler return its 400.
  const isKnownRegion = Object.values(S3Region).includes(region as S3Region);
  if (!bucketName || (isKnownRegion && !ragKeyAllowsBucket(record, region, bucketName))) {
    return bucketNotFoundResponse();
  }

  // The token has served its purpose — strip it so nothing downstream (error
  // handlers, debug logging) can ever echo it.
  delete event.headers.authorization;

  // Read consistently, exactly as the cookie path does: a key minted moments
  // after its creator joined must not query as a non-member.
  const membership = await resolveMembership(record.orgId, record.createdBy);

  const userInfo: UserInfo = {
    sub: `ragkey|${record.keyId}`,
    userId: record.createdBy,
    orgId: record.orgId,
    email: record.creatorEmail,
    // creatorEmail was captured via getVerifiedEmail at creation time.
    emailVerified: true,
    name: record.keyName,
    ...(membership ? { membership } : {}),
  };
  (
    event.requestContext as APIGatewayProxyEventV2['requestContext'] & { userInfo: UserInfo }
  ).userInfo = userInfo;

  // A creator who has left the org takes their keys with them. Refused before
  // last-used is stamped, so a dead key leaves no trace of having worked. The
  // membership is attached above either way, because the denial reads it back
  // out of `userInfo` like every other gate does.
  const notAMember = requireMembership(event as AuthenticatedEvent);
  if (notAMember) return notAMember;

  await touchRagKeyLastUsed(record.orgId, record.keyId);
  return undefined;
}

export interface RagQueryAuthOptions extends AuthMiddlewareOptions {
  /**
   * The route manifest's `cookieRequires`: what a caller arriving with a cookie
   * session instead of a bearer token must hold. Passed in rather than read
   * from the manifest so the requirement sits in the handler's own chain, where
   * every other route's requirement is.
   */
  cookieRequires: Permission;
}

export function ragQueryAuthMiddleware({ cookieRequires, ...options }: RagQueryAuthOptions) {
  const cookieAuth = authMiddleware(options);

  const before = (async (
    request: QueryAuthRequest,
  ): Promise<APIGatewayProxyStructuredResultV2 | void> => {
    const authHeader = request.event.headers?.authorization;
    if (authHeader === undefined) {
      request.internal.usedCookieAuth = true;
      const failure = await cookieAuth.before(request);
      if (failure) return failure;
      // The cookie caller is an ordinary console user reading bucket contents.
      // Returning here short-circuits the after stack, so a rotated cookie set
      // rides the denial — otherwise one refused query logs the caller out.
      const denied = requirePermission(request.event as AuthenticatedEvent, cookieRequires);
      return denied ? withRefreshedCookies(request, denied) : undefined;
    }
    return bearerAuth(request, authHeader);
  }) as (
    r: Request<APIGatewayProxyEventV2, APIGatewayProxyResultV2>,
  ) => Promise<APIGatewayProxyStructuredResultV2 | void>;

  const after = (async (request: QueryAuthRequest): Promise<void> => {
    // Cookie refresh / re-issue only applies to the cookie path.
    if (request.internal.usedCookieAuth) {
      return cookieAuth.after?.(request);
    }
  }) as (r: Request<APIGatewayProxyEventV2, APIGatewayProxyResultV2>) => Promise<void>;

  return { before, after } satisfies MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2>;
}
