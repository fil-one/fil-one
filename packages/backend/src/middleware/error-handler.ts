import type { MiddlewareObj, Request } from '@middy/core';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import type { ErrorResponse } from '@filone/shared';
import { IamRegionRefusedError } from '../lib/errors.ts';
import { OrgDeletingError } from '../lib/org-profile.ts';
import {
  ResponseBuilder,
  accountDeletedResponse,
  storageTimeoutResponse,
  unexpectedFailureResponse,
} from '../lib/response-builder.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';

export function errorHandlerMiddleware(): MiddlewareObj<
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2
> {
  const onError = async (
    request: Request<APIGatewayProxyEventV2, APIGatewayProxyResultV2, Error, Context>,
  ): Promise<void> => {
    // Expected, not a fault: the org is being deleted and every writer refuses.
    // Mapped here so no writer has to catch it, and so it can never be
    // swallowed into a "try again in a moment" the caller would act on.
    if (request.error instanceof OrgDeletingError) {
      console.warn('[error-handler] write refused, org is being deleted', {
        orgId: request.error.orgId,
      });
      request.response = accountDeletedResponse();
      return;
    }

    // A storage region would not register or remove the member's principal, so
    // the membership write was refused and the same request tries again.
    if (request.error instanceof IamRegionRefusedError) {
      const { action, regions, succeeded } = request.error;
      console.warn('[error-handler] membership write refused by an iam region', {
        action,
        regions,
        succeeded,
      });
      request.response = new ResponseBuilder()
        .status(502)
        .body<ErrorResponse>({ message: getIamRegionRefusedMessage(action, regions, succeeded) })
        .build();
      return;
    }

    // Log the full error internally — never expose details to the caller.
    // userInfo is only present when the error occurred after authMiddleware;
    // apiRequestId is the API Gateway request id, correlating with the API
    // access logs (the Lambda-injected requestId in the JSON envelope differs).
    const requestContext = (request.event as Partial<AuthenticatedEvent>).requestContext;
    const userInfo = requestContext?.userInfo;
    console.error(
      'Unhandled handler error:',
      {
        orgId: userInfo?.orgId,
        userId: userInfo?.userId,
        apiRequestId: request.event.requestContext?.requestId,
      },
      request.error,
    );

    request.response = isCausedByDeadline(request.error, requestContext?.deadline)
      ? storageTimeoutResponse()
      : unexpectedFailureResponse();
  };

  return { onError };
}

// Deeper than any wrapping the clients and the orchestrator add, and a bound
// keeps a cyclic `cause` chain from hanging the error handler.
const MAX_CAUSE_DEPTH = 10;

/**
 * Whether the error is the request deadline's own abort or wraps it as a
 * `cause`. `fetch` rejects with the signal's `reason` itself; the AWS SDK and
 * the orchestrator wrap it. Matching that object, rather than any fired
 * deadline, keeps the 500 for an error a handler threw after it had already
 * dealt with an aborted call, such as a fan-out that settled one region's
 * timeout and then failed for another reason.
 */
function isCausedByDeadline(error: unknown, deadline: AbortSignal | undefined): boolean {
  if (!deadline?.aborted) return false;
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    if (current === deadline.reason) return true;
    current = current.cause;
  }
  return false;
}

/**
 * What the user is told. The state is partial when some regions applied the
 * change, so the message says which did and which did not; when none did, the
 * region names add nothing. Either way the remedy is the same request again.
 */
function getIamRegionRefusedMessage(
  action: 'register' | 'remove',
  regions: string[],
  succeeded: string[],
): string {
  const failed = regions.join(', ');
  const done = succeeded.join(', ');
  if (action === 'remove') {
    return succeeded.length > 0
      ? `The member was removed from ${done} but could not be removed from ${failed}. They are still in this organization, please try again.`
      : 'We could not remove the member from this organization. Please try again.';
  }
  return succeeded.length > 0
    ? `The member joined, and was registered on ${done} but not on ${failed}. Please try again.`
    : 'The member joined, but could not be registered on the storage regions. Please try again.';
}
