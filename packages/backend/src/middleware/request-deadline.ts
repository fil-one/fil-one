import type { MiddlewareObj, Request } from '@middy/core';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import type { AuthenticatedEvent } from '../lib/user-context.ts';

// Time left between the request deadline and the Lambda timeout, for the
// handler to answer once an upstream call aborts: combine what the other
// regions returned, log the failure and send the response.
export const REQUEST_DEADLINE_MARGIN_MS = 500;

/**
 * Attaches `requestContext.deadline`, a signal that aborts
 * {@link REQUEST_DEADLINE_MARGIN_MS} before the Lambda timeout. Handlers pass
 * it to every upstream call, so a hung upstream fails that call and the
 * handler's own error handling runs, instead of the Lambda timeout killing the
 * handler with nothing logged.
 *
 * The deadline comes from the invocation's remaining time, so it follows each
 * route's configured timeout, and the time spent in middleware and in reads
 * before the first upstream call counts against it.
 */
export function requestDeadlineMiddleware() {
  const before = (
    request: Request<APIGatewayProxyEventV2, APIGatewayProxyResultV2, Error, Context>,
  ): void => {
    const remainingMs = request.context.getRemainingTimeInMillis();
    (
      request.event.requestContext as APIGatewayProxyEventV2['requestContext'] & {
        deadline: AbortSignal;
      }
    ).deadline = AbortSignal.timeout(Math.max(0, remainingMs - REQUEST_DEADLINE_MARGIN_MS));
  };

  return { before } satisfies MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2>;
}

/** The signal {@link requestDeadlineMiddleware} attached to this request. */
export function getRequestDeadline(event: AuthenticatedEvent): AbortSignal {
  const { deadline } = event.requestContext;
  if (!deadline) {
    throw new Error(
      'The request has no deadline: add requestDeadlineMiddleware() to the handler chain',
    );
  }
  return deadline;
}
