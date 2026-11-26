import type { Request } from '@middy/core';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { ROUTE_MANIFEST, type RouteHandler } from '@filone/shared';
import { requirePermission } from '../../middleware/authorize.ts';
import { AccessLevel, subscriptionGuardMiddleware } from '../../middleware/subscription-guard.ts';
import type { AuthenticatedEvent } from '../user-context.ts';

/** A console route's handler, past its middleware chain. */
export type ConsoleHandler = (event: AuthenticatedEvent) => Promise<APIGatewayProxyResultV2>;

export interface ConsoleRouteCall {
  /** The handler module, as the route manifest names it. */
  handler: RouteHandler;
  baseHandler: ConsoleHandler;
  /** The access level the route's subscription guard runs at. */
  accessLevel: AccessLevel;
  pathParameters?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  body?: unknown;
}

export interface ConsoleRouteResult {
  statusCode: number;
  body: unknown;
}

/**
 * Runs a console route for an MCP tool, as the caller of the MCP request: the
 * permission the route manifest names, the subscription guard at the route's
 * level, then the route's own handler. The MCP chain has already authenticated
 * the caller and run the guard at read level.
 */
export async function callConsoleRoute(
  mcpEvent: AuthenticatedEvent,
  call: ConsoleRouteCall,
): Promise<ConsoleRouteResult> {
  const event: AuthenticatedEvent = {
    ...mcpEvent,
    pathParameters: call.pathParameters,
    queryStringParameters: call.queryStringParameters,
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
    isBase64Encoded: false,
  };
  const refused =
    checkRouteRequirement(event, call.handler) ?? (await checkWriteAccess(event, call));
  return toConsoleRouteResult(refused ?? (await call.baseHandler(event)));
}

/** A route requiring a permission is refused here; 'self' and 'in-handler' routes check their own. */
function checkRouteRequirement(event: AuthenticatedEvent, handler: RouteHandler) {
  const requires = ROUTE_MANIFEST.find((route) => route.handler === handler)?.requires;
  if (
    !requires ||
    requires === 'self' ||
    requires === 'in-handler' ||
    requires === 'invite-token'
  ) {
    return undefined;
  }
  return requirePermission(event, requires);
}

async function checkWriteAccess(event: AuthenticatedEvent, call: ConsoleRouteCall) {
  if (call.accessLevel !== AccessLevel.Write) return undefined;
  // The guard reads only the event, and `internal` for refreshed cookies, which
  // a bearer request never has; a middy request needs the other fields only to
  // run a whole chain.
  const request = { event, internal: {} } as unknown as Request<
    APIGatewayProxyEventV2,
    APIGatewayProxyResultV2,
    Error,
    Context
  >;
  return (await subscriptionGuardMiddleware(AccessLevel.Write).before(request)) ?? undefined;
}

/** A route handler's answer, with its JSON body parsed. */
export function toConsoleRouteResult(result: APIGatewayProxyResultV2): ConsoleRouteResult {
  // Console handlers answer with a structured result; a bare string is API Gateway's 200 shorthand.
  if (typeof result === 'string') return { statusCode: 200, body: JSON.parse(result) };
  const { statusCode = 200, body } = result;
  return { statusCode, body: body ? JSON.parse(body) : undefined };
}
