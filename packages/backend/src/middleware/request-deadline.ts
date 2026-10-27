import type { MiddlewareObj, Request } from '@middy/core';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import type { AuthenticatedEvent } from '../lib/user-context.ts';

// Time left between the request deadline and the Lambda timeout, for the
// handler to answer once an upstream call aborts: combine what the other
// regions returned, log the failure and send the response.
export const REQUEST_DEADLINE_MARGIN_MS = 500;

// The API Gateway request context plus the fields this middleware writes and
// reads, which the AWS type does not declare.
type DeadlineRequestContext = APIGatewayProxyEventV2['requestContext'] & {
  deadline: AbortSignal;
  deadlineStep?: string;
  deadlineStepsInFlight?: string[];
  userInfo?: { orgId?: string; userId?: string };
};

type DeadlineRequest = Request<APIGatewayProxyEventV2, APIGatewayProxyResultV2, Error, Context>;

// The abort listener of each request still in flight, so the request's end can
// remove it. Without that, a warm container thawed for the next invocation would
// fire the old timer and log a deadline for a request that had already answered.
const stopDeadlineLogs = new WeakMap<APIGatewayProxyEventV2, () => void>();

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
 *
 * When the deadline fires it is logged, with the step marked by
 * {@link markRequestStep} and every step {@link trackRequestStep} still has in
 * flight. That names the call even when it takes no signal and goes on hanging
 * until the Lambda timeout.
 */
export function requestDeadlineMiddleware() {
  const before = (request: DeadlineRequest): void => {
    const remainingMs = request.context.getRemainingTimeInMillis();
    const requestContext = request.event.requestContext as DeadlineRequestContext;
    const deadline = AbortSignal.timeout(Math.max(0, remainingMs - REQUEST_DEADLINE_MARGIN_MS));
    requestContext.deadline = deadline;

    const logDeadlineReached = () => {
      const { deadlineStep } = requestContext;
      console.error('[request-deadline] Request deadline reached', {
        ...(deadlineStep !== undefined && { step: deadlineStep }),
        // A copy: the steps still running settle after this line is written.
        stepsInFlight: [...(requestContext.deadlineStepsInFlight ?? [])],
        orgId: requestContext.userInfo?.orgId,
        userId: requestContext.userInfo?.userId,
        apiRequestId: requestContext.requestId,
      });
    };
    deadline.addEventListener('abort', logDeadlineReached, { once: true });
    stopDeadlineLogs.set(request.event, () =>
      deadline.removeEventListener('abort', logDeadlineReached),
    );
  };

  const stopDeadlineLog = (request: DeadlineRequest): void => {
    stopDeadlineLogs.get(request.event)?.();
    stopDeadlineLogs.delete(request.event);
  };

  return {
    before,
    after: stopDeadlineLog,
    onError: stopDeadlineLog,
  } satisfies MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2>;
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

/**
 * Names the upstream call the handler is about to await, for the log line
 * {@link requestDeadlineMiddleware} writes if the deadline fires during it.
 */
export function markRequestStep(event: AuthenticatedEvent, step: string): void {
  event.requestContext.deadlineStep = step;
}

/**
 * Runs one upstream call as a named step, for the log line
 * {@link requestDeadlineMiddleware} writes if the deadline fires before the
 * call settles. Unlike {@link markRequestStep} it suits calls that run
 * concurrently: the log names every step still running.
 */
export async function trackRequestStep<T>(
  event: AuthenticatedEvent,
  step: string,
  run: () => Promise<T>,
): Promise<T> {
  const stepsInFlight = (event.requestContext.deadlineStepsInFlight ??= []);
  stepsInFlight.push(step);
  try {
    return await run();
  } finally {
    stepsInFlight.splice(stepsInFlight.indexOf(step), 1);
  }
}
