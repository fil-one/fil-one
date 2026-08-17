import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ORG_ID_HEADER, isUuid } from '@filone/shared';
import type { ErrorResponse } from '@filone/shared';
import { ResponseBuilder } from '../lib/response-builder.js';
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
 * Once an org carries an `auth0OrgId`, a request naming it in {@link
 * ORG_ID_HEADER} is refused unless the session's `org_id` claim matches. An
 * org's Auth0-side connection restrictions and authentication policy must not be
 * bypassable from a session authenticated elsewhere.
 *
 * Nothing writes `auth0OrgId` in M1, so the attribute is read tolerantly and the
 * common answer is "no restriction" — the rule is here as code rather than prose
 * so adopting Auth0 Organizations is a write, not a new enforcement path.
 */
async function enforceIdentityProvider(
  orgId: string,
  sessionAuth0OrgId: string | null,
): Promise<APIGatewayProxyStructuredResultV2 | undefined> {
  let auth0OrgId: string | undefined;
  try {
    auth0OrgId = (await getOrgProfile(orgId))?.auth0OrgId?.S;
  } catch (err) {
    console.error('[org-context] Org profile read failed — cannot honor the org header', {
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
  /** Set when the header cannot be honored; the chain short-circuits with it. */
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
 * Runs after identity resolution and before the membership read, so the row that
 * gets read is the caller's row in the org the request is actually about.
 */
export async function resolveActiveOrg(
  event: AuthenticatedEvent,
  sessionAuth0OrgId: string | null,
): Promise<ActiveOrgResolution> {
  const header = getRequestHeader(event, ORG_ID_HEADER);
  if (header === undefined) return {};

  // Validated before the value touches a key expression, and before it is worth
  // a read: an org id is a UUID, and anything else is a client error.
  if (!isUuid(header)) return { response: malformedOrgHeaderResponse() };

  const { userInfo } = event.requestContext;
  const rejection = await enforceIdentityProvider(header, sessionAuth0OrgId);
  if (rejection) return { response: rejection };

  if (header === userInfo.orgId) return {};

  const personalOrgId = userInfo.orgId;
  userInfo.orgId = header;
  // The signup branch attaches the membership row it has just written, for the
  // org it created. The header names a different one, so that row is not this
  // request's membership and the read has to happen.
  delete userInfo.membership;

  return { personalOrgId };
}
