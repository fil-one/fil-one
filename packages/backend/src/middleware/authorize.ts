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
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';

/**
 * The console's authorization gate: the caller's role in the active org either
 * carries the permission a route declares in the route manifest, or the request
 * is refused before the handler runs.
 *
 * Fail-closed by construction. There is no membership row to read here —
 * `authMiddleware` has already resolved it onto `userInfo` — so the only two
 * outcomes are "the row grants this" and a 403. An absent row, a role that is
 * not one of the four, and a role without the permission each deny; nothing
 * falls through to a default.
 *
 * Installed immediately after `authMiddleware()` and before
 * `subscriptionGuardMiddleware()`, so a non-member gets an authorization error
 * rather than a billing error and never costs a BillingTable read.
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
 * The conversion is supposed to leave every account with one, so this is the
 * signal that it missed a cohort — an alarm on it turns a silent lockout into a
 * page, rather than into a support ticket a day later. The route is the only
 * dimension: it is bounded by the manifest, while org and user ids are not.
 */
function reportNotAMember(event: APIGatewayProxyEventV2, orgId: string, userId: string): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [['route']],
          Metrics: [{ Name: 'NotAMemberDenialCount', Unit: 'Count' }],
        },
      ],
    },
    route: event.requestContext.routeKey,
    NotAMemberDenialCount: 1,
  });
  console.error('[authorize] Denied — the caller has no membership row in the active org', {
    orgId,
    userId,
    route: event.requestContext.routeKey,
  });
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
  const { membership, orgId, userId } = getUserInfo(event);
  if (membership) return undefined;

  reportNotAMember(event, orgId, userId);
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

  const { membership } = getUserInfo(event);

  if (!roleHasPermission(membership!.role, permission)) {
    return forbiddenRoleResponse(
      denialMessage ?? `Your role in this organization does not permit this action.`,
    );
  }

  return undefined;
}

/**
 * Middy before-hook enforcing one permission from the route manifest.
 *
 * @param permission the manifest's `requires` value for this route.
 */
export function authorize(permission: Permission) {
  const before = (
    request: Request<APIGatewayProxyEventV2, APIGatewayProxyResultV2, Error, Context>,
  ): APIGatewayProxyStructuredResultV2 | void =>
    requirePermission(request.event as AuthenticatedEvent, permission);

  return { before } satisfies MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2>;
}
