import type { MiddlewareObj, Request } from '@middy/core';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { ApiErrorCode, roleHasPermission } from '@filone/shared';
import type { ErrorResponse, Permission } from '@filone/shared';
import { ResponseBuilder } from '../lib/response-builder.js';
import { reportMetric } from '../lib/metrics.js';
import type { AuthenticatedEvent, UserInfo } from '../lib/user-context.js';
import { withRefreshedCookies } from './auth.js';

/**
 * The console's authorization gate: the caller's role in the active org either
 * carries the permission a route declares in the route manifest, or the request
 * is refused before the handler runs.
 *
 * Fail-closed by construction. There is no membership row to read here —
 * `authMiddleware` has already resolved it onto `userInfo` — so the only two
 * outcomes are "the row grants this" and a 403. An absent row, a role that is
 * not one of the four, a `userInfo` that never arrived, and a role without the
 * permission each deny; nothing falls through to a default.
 *
 * Installed immediately after `authMiddleware()` and before
 * `subscriptionGuardMiddleware()`, so a non-member gets an authorization error
 * rather than a billing error and never costs a BillingTable read.
 *
 * Every denial goes out through `withRefreshedCookies`: the request may have
 * rotated the caller's tokens moments ago in `authMiddleware`, and a
 * short-circuit skips the after hook that would have set them.
 */

/** The caller has no membership row in the org the request is operating on. */
function notAMemberResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(403)
    .body<ErrorResponse>({
      message: 'You are not a member of this organization.',
      code: ApiErrorCode.NOT_A_MEMBER,
    })
    .build();
}

/** The caller is a member, and their role does not carry what the route needs. */
function forbiddenRoleResponse(message: string): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(403)
    .body<ErrorResponse>({ message, code: ApiErrorCode.FORBIDDEN_ROLE })
    .build();
}

/**
 * Count a caller refused for having no membership row.
 *
 * A console session and a RAG key are counted apart, because the two mean
 * different things. `NotAMemberDenialCount` is the conversion's alarm: every
 * account is supposed to have a row, so a non-zero count says a cohort was
 * missed, and the runbook reads it that way. A key whose creator has left the
 * org is the design working — `RevokedKeyCreatorDenialCount` records it without
 * putting a lockout page on somebody's screen. The route is the only dimension:
 * it is bounded by the manifest, while org and user ids are not.
 */
function reportNotAMember(
  event: APIGatewayProxyEventV2,
  { orgId, userId, apiKeySession }: UserInfo,
): void {
  const metric = apiKeySession ? 'RevokedKeyCreatorDenialCount' : 'NotAMemberDenialCount';
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [['route']],
          Metrics: [{ Name: metric, Unit: 'Count' }],
        },
      ],
    },
    route: event.requestContext.routeKey,
    [metric]: 1,
  });
  console.error(
    apiKeySession
      ? '[authorize] Denied — the RAG key creator has no membership row in the key org'
      : '[authorize] Denied — the caller has no membership row in the active org',
    { orgId, userId, route: event.requestContext.routeKey },
  );
}

/**
 * Refuse a caller with no membership row, counting the denial.
 *
 * The whole check for a caller whose authority is the membership itself rather
 * than a permission: the RAG bearer token carries its own authority, and what
 * it needs from the org is that its creator is still in it.
 */
export function requireMembership(
  event: AuthenticatedEvent,
): APIGatewayProxyStructuredResultV2 | undefined {
  const userInfo = event.requestContext.userInfo as UserInfo | undefined;

  // A chain that reaches this gate without `authMiddleware` in front of it has
  // no caller to authorize. Denying is the only safe reading, and the log names
  // the wiring rather than the user: no metric, because the alarm on
  // NotAMemberDenialCount means "the conversion missed a cohort" and this is a
  // route that was assembled wrong.
  if (!userInfo) {
    console.error(
      '[authorize] Denied — no userInfo on the request; this chain is missing authMiddleware',
      { route: event.requestContext.routeKey },
    );
    return notAMemberResponse();
  }

  if (userInfo.membership) return undefined;

  reportNotAMember(event, userInfo);
  return notAMemberResponse();
}

/**
 * Check one permission against the caller's membership, returning the denial
 * response or undefined when the caller holds it.
 *
 * Exported because four routes serve several requirements through one path —
 * presign's seven operations, the key-creation cap, RAG enablement on and off,
 * the org rename — and their checks must speak the same registry and produce
 * the same two error codes as the middleware. `denialMessage` names what was
 * refused, which is the difference between "your role cannot do that" and a
 * message a support agent can act on.
 */
export function requirePermission(
  event: AuthenticatedEvent,
  permission: Permission,
  denialMessage?: string,
): APIGatewayProxyStructuredResultV2 | undefined {
  const absent = requireMembership(event);
  if (absent) return absent;

  // requireMembership returned nothing, so both the userInfo and its membership
  // are there.
  const { membership } = event.requestContext.userInfo;

  if (!roleHasPermission(membership!.role, permission)) {
    return forbiddenRoleResponse(
      denialMessage ?? `Your role in this organization does not permit this action.`,
    );
  }

  return undefined;
}

type GateRequest = Request<APIGatewayProxyEventV2, APIGatewayProxyResultV2, Error, Context>;

/**
 * Middy before-hook enforcing one permission from the route manifest.
 *
 * @param permission the manifest's `requires` value for this route.
 */
export function authorize(permission: Permission) {
  const before = (request: GateRequest): APIGatewayProxyStructuredResultV2 | void => {
    const denied = requirePermission(request.event as AuthenticatedEvent, permission);
    return denied ? withRefreshedCookies(request, denied) : undefined;
  };

  return { before } satisfies MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2>;
}

/**
 * Middy before-hook asking only that the caller is a member of the active org.
 *
 * For the routes whose permission depends on the request body: the handler
 * decides which permission the body needs, but nothing about a body makes a
 * non-member a member, so membership is settled in the chain. That keeps the
 * denial where every other route's is — ahead of `subscriptionGuardMiddleware`,
 * so a non-member costs no BillingTable read, and inside the metric that says
 * whether the conversion missed a cohort.
 */
export function requireOrgMembershipMiddleware() {
  const before = (request: GateRequest): APIGatewayProxyStructuredResultV2 | void => {
    const denied = requireMembership(request.event as AuthenticatedEvent);
    return denied ? withRefreshedCookies(request, denied) : undefined;
  };

  return { before } satisfies MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2>;
}
