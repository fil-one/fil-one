import type { MiddlewareObj, Request } from '@middy/core';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { S3Region } from '@filone/shared';
import type { ErrorResponse } from '@filone/shared';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { UserInfo } from '../lib/user-context.js';
import { findRagKeyByToken, ragKeyAllowsBucket, touchRagKeyLastUsed } from '../lib/rag-api-keys.js';
import { authMiddleware } from './auth.js';
import type { AuthMiddlewareOptions } from './auth.js';

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
 */

interface RagQueryAuthInternal extends Record<string, unknown> {
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

  // Same region resolution as the handler (query-bucket defaults to eu-west-1)
  // so the scope comparison and the handler can never disagree. Unsupported
  // region values fall through to the handler's isSupportedRegion 400.
  const bucketName = event.pathParameters?.name;
  const region = event.queryStringParameters?.region ?? S3Region.EuWest1;
  if (!bucketName || !ragKeyAllowsBucket(record, region, bucketName)) {
    return bucketNotFoundResponse();
  }

  const userInfo: UserInfo = {
    sub: `ragkey|${record.keyId}`,
    userId: record.createdBy,
    orgId: record.orgId,
    email: record.creatorEmail,
    // creatorEmail was captured via getVerifiedEmail at creation time.
    emailVerified: true,
    name: record.keyName,
  };
  (
    event.requestContext as APIGatewayProxyEventV2['requestContext'] & { userInfo: UserInfo }
  ).userInfo = userInfo;

  // The token has served its purpose — strip it so nothing downstream (error
  // handlers, debug logging) can ever echo it.
  delete event.headers.authorization;

  await touchRagKeyLastUsed(record.orgId, record.keyId);
  return undefined;
}

export function ragQueryAuthMiddleware(options: AuthMiddlewareOptions = {}) {
  const cookieAuth = authMiddleware(options);

  const before = async (
    request: QueryAuthRequest,
  ): Promise<APIGatewayProxyStructuredResultV2 | void> => {
    const authHeader = request.event.headers?.authorization;
    if (authHeader === undefined) {
      request.internal.usedCookieAuth = true;
      return cookieAuth.before(request);
    }
    return bearerAuth(request, authHeader);
  };

  const after = async (request: QueryAuthRequest): Promise<void> => {
    // Cookie refresh / re-issue only applies to the cookie path.
    if (request.internal.usedCookieAuth) {
      return cookieAuth.after?.(request);
    }
  };

  return { before, after } satisfies MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2>;
}
