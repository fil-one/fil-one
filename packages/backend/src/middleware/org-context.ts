import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ORG_ID_HEADER, isUuid } from '@filone/shared';
import type { ErrorResponse } from '@filone/shared';
import { accountDeletedResponse, ResponseBuilder } from '../lib/response-builder.js';
import { getRequestHeader } from '../lib/request-headers.js';
import { getOrgProfile } from '../lib/org-profile.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';

/**
 * Which organization a request is about.
 *
 * Multi-org membership needs an input that names the org, and the header is it:
 * `X-Org-Id`, sent by the console on every call. Absent, the active org is the
 * identity row's own — today's behavior, and what a curl caller still gets.
 * Present, it becomes `userInfo.orgId`, and every downstream handler, guard, and
 * key expression stays untouched: the role for that org is resolved from the
 * membership row the auth middleware already reads, so a revoked membership dies
 * on the next request with no invalidation machinery.
 *
 * Nothing about the token changes, which is the point — the header carries no
 * authority of its own. It selects which org the caller's membership is read in,
 * and a caller with no row there is refused by `authorize` exactly as one whose
 * membership was revoked in their own org is.
 *
 * Two steps, in this order, sequenced by `completeAuthentication`:
 * {@link resolveActiveOrg} picks the org from the header without reading
 * anything, the membership read decides whether the caller may be in it, and
 * {@link enforceIdentityProvider} then reads that org's profile. The order is
 * the security property — see each function for the half it carries.
 */

/** The value is not a UUID, so it never reaches a DynamoDB key expression. */
function malformedOrgHeaderResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(400)
    .body<ErrorResponse>({ message: `${ORG_ID_HEADER} must be an organization id.` })
    .build();
}

/**
 * The org authenticates through its own identity provider, and this session did
 * not come from there.
 *
 * No `ApiErrorCode`: the console's two role codes describe a caller's standing
 * inside an org, and this is a refusal to enter one at all. It carries a message
 * instead, which the console renders as-is.
 */
function wrongIdentityProviderResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(403)
    .body<ErrorResponse>({
      message: 'This organization requires signing in through its own identity provider.',
    })
    .build();
}

/**
 * The org's configuration would not read. Retryable and ours, so a 503 — the
 * same reading the membership read's failure gets, and for the same reason:
 * treating an unreadable row as an unrestricted org would fail open on exactly
 * the check that exists to keep a session from entering an org it was not
 * authenticated for.
 */
function orgProfileUnavailableResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(503)
    .body<ErrorResponse>({
      message: 'We could not read that organization. Please try again in a moment.',
    })
    .build();
}

/**
 * Once an org carries an `auth0OrgId`, a session that did not authenticate at
 * that Auth0 organization may not act in it. An org's Auth0-side connection
 * restrictions and authentication policy must not be bypassable from a session
 * authenticated elsewhere.
 *
 * Applied to the org the request resolved to, whether the header named it or the
 * identity row did. Running it only on the header path would make the rule
 * bypassable by omission: a session that never authenticated at the org could
 * reach it by sending no header at all. The caller's own org is included on
 * purpose — an SSO org can be somebody's own, and the refusal is enforcement,
 * with re-authenticating through the org's provider as the way back in.
 *
 * Runs after the membership read, and only for a caller who has one. A caller
 * probing org ids they are not in gets the same 403 either way, so this read
 * cannot be used to ask which orgs have SSO configured.
 *
 * Nothing writes `auth0OrgId` in M1, so the attribute is read tolerantly and the
 * common answer is "no restriction" — the rule is here as code rather than prose
 * so adopting Auth0 Organizations is a write, not a new enforcement path.
 */
export async function enforceIdentityProvider(
  orgId: string,
  sessionAuth0OrgId: string | null,
): Promise<APIGatewayProxyStructuredResultV2 | undefined> {
  let auth0OrgId: string | undefined;
  try {
    // Consistent: `auth0OrgId` is not write-once, and a stale replica answering
    // "no restriction" would admit the session this rule exists to refuse.
    const profile = await getOrgProfile(orgId, { consistentRead: true });
    // The active-org half of the session fence. The sign-in path fences the
    // identity row's org; this read — the only per-request look at the ACTIVE
    // org's profile, and only a member gets this far — is where a deleting org
    // named in `X-Org-Id` refuses, so a member cannot keep operating in a
    // teardown through the header. A response rather than a throw, so `/api/me`'s
    // fallback can degrade a stashed deleting org to the caller's own.
    if (profile?.deleting?.BOOL === true) return accountDeletedResponse();
    auth0OrgId = profile?.auth0OrgId?.S;
  } catch (err) {
    console.error('[org-context] Org profile read failed — cannot decide who may enter the org', {
      orgId,
      error: err,
    });
    return orgProfileUnavailableResponse();
  }

  if (!auth0OrgId || auth0OrgId === sessionAuth0OrgId) return undefined;

  console.warn('[org-context] Refused an org whose identity provider the session did not use', {
    orgId,
    // The org's own id, not the session's claim: what the caller presented is
    // theirs to know and not ours to log.
    auth0OrgId,
  });
  return wrongIdentityProviderResponse();
}

export interface ActiveOrgResolution {
  /** Set when the header is not an organization id; the chain refuses with it. */
  response?: APIGatewayProxyStructuredResultV2;
  /**
   * The identity row's own org, set only when the header moved the active org
   * off it. `/api/me` uses it as the fallback that keeps a stale stashed org
   * from locking the console out of its own recovery surface.
   */
  personalOrgId?: string;
}

/**
 * Resolve the active org from the request header, replacing `userInfo.orgId`
 * when one is named.
 *
 * Reads nothing. Which org a request is about is decided from the header and the
 * identity row alone, so the membership read that follows is the first thing
 * this request spends, and it is spent on the org the request is actually about.
 * Everything that consults a row — membership, then the identity-provider rule —
 * runs after this returns.
 */
export function resolveActiveOrg(event: AuthenticatedEvent): ActiveOrgResolution {
  const header = getRequestHeader(event, ORG_ID_HEADER);
  if (header === undefined) return {};

  // Validated before the value touches a key expression, and before it is worth
  // a read: an org id is a UUID, and anything else is a client error.
  if (!isUuid(header)) return { response: malformedOrgHeaderResponse() };

  // `isUuid` accepts upper case because the spec calls it valid input, and every
  // key here is compared byte for byte against ids this system minted in lower
  // case. Left as sent, `ACME…` would validate and then match no membership row,
  // answering "you are not a member" to a caller whose only mistake was the
  // spelling of a header.
  const requested = header.toLowerCase();

  const { userInfo } = event.requestContext;
  if (requested === userInfo.orgId) return {};

  const personalOrgId = userInfo.orgId;
  userInfo.orgId = requested;
  // The signup branch attaches the membership row it has just written, for the
  // org it created. The header names a different one, so that row is not this
  // request's membership and the read has to happen.
  delete userInfo.membership;

  return { personalOrgId };
}
