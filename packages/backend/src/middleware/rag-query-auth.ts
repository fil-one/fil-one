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
import { accountDeletedResponse } from '../lib/account-deleted-response.js';
import type { UserInfo } from '../lib/user-context.js';
import { getOrgProfile, isOrgDeleting } from '../lib/org-profile.js';
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
 *
 * Account deletion (FIL-112) is the one gate the downstream chain cannot
 * enforce for this path, so `bearerAuth` checks it here — see the comment on
 * the fence-B read below.
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

  // FIL-112 fence B. Without this the bearer path sits outside every deletion
  // fence: the SUB# tombstone can never match (the synthetic sub below has no
  // SUB# row) and the downstream subscription guard reads only
  // `subscriptionStatus`, which the billing fence leaves untouched. So an
  // `sk_rag_…` key would keep serving bucket content for the whole teardown
  // window.
  //
  // What this covers, precisely: the **deleting window** — from `deleting =
  // true` being set through the end of the purge. It does *not* extend past
  // the purge. `purgeRecords` batch-deletes the whole `ORG#{orgId}` partition
  // (everything but the DELETION row), PROFILE included, and
  // `isOrgDeleting(undefined)` is `false` — so once PROFILE is gone this fence
  // reads nothing and fails OPEN. Post-purge protection then rests entirely on
  // `findRagKeyByToken` returning null, which needs BOTH the
  // `RAGKEYHASH#/LOOKUP` and `ORG#/RAGKEY#` rows to be gone. RAGKEY# is
  // deleted in the same unordered batch as PROFILE, so a partial batch failure
  // that keeps RAGKEY# while dropping PROFILE reopens the hole permanently.
  // The real closure is the purge-ordering fix — deleting the RAGKEYHASH# rows
  // after, or atomically with, the ORG-partition delete — which lands with the
  // teardown work, not here.
  //
  // `record.orgId` is authoritative — it comes from the stored LOOKUP row,
  // never from the request. The read must be strongly consistent because
  // `deleting` is absent until teardown starts, so a stale read fails open
  // (see the read-semantics note in lib/org-profile.ts).
  //
  // Rejected as 410 ACCOUNT_DELETED, the same response every other
  // deleted-account path emits (lib/account-deleted-response.ts): a 401 invites
  // a machine client to rotate credentials and retry forever, while a 410 tells
  // it definitively to stop. That is the same reasoning that drove the 401→410
  // unification this change also makes; a third behaviour for one condition is
  // exactly the drift that unification exists to remove. No no-oracle argument
  // is being made for a bare 401 here, because there is none to make: this
  // module already discloses token validity by status (a valid token outside
  // its bucket scope gets 404 above, an unknown token gets 401), and this path
  // costs three DynamoDB reads against an unknown token's one, which is
  // trivially separable by latency. The `console.warn` below carries `orgId`
  // and `keyId`, so on-call can tell "deleting org" from "revoked key" — an
  // ambiguity that is otherwise a real support cost, and one the response
  // deliberately does not resolve for the caller.
  if (isOrgDeleting(await getOrgProfile(record.orgId, { consistent: true }))) {
    console.warn('[rag-key-auth] Rejecting bearer auth: org deletion in progress', {
      orgId: record.orgId,
      keyId: record.keyId,
    });
    return accountDeletedResponse();
  }

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

  const before = (async (
    request: QueryAuthRequest,
  ): Promise<APIGatewayProxyStructuredResultV2 | void> => {
    const authHeader = request.event.headers?.authorization;
    if (authHeader === undefined) {
      request.internal.usedCookieAuth = true;
      return cookieAuth.before(request);
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
