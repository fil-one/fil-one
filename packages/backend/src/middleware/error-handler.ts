import type { MiddlewareObj, Request } from '@middy/core';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import type { ErrorResponse } from '@filone/shared';
import { OrgDeletingError } from '../lib/org-profile.js';
import { accountDeletedResponse, ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';

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

    // Log the full error internally — never expose details to the caller.
    // userInfo is only present when the error occurred after authMiddleware;
    // apiRequestId is the API Gateway request id, correlating with the API
    // access logs (the Lambda-injected requestId in the JSON envelope differs).
    const userInfo = (request.event as Partial<AuthenticatedEvent>).requestContext?.userInfo;
    console.error(
      'Unhandled handler error:',
      {
        orgId: userInfo?.orgId,
        userId: userInfo?.userId,
        apiRequestId: request.event.requestContext?.requestId,
      },
      request.error,
    );

    request.response = new ResponseBuilder()
      .status(500)
      .body<ErrorResponse>({
        message: 'An unexpected server error occurred. Please try again later.',
      })
      .build();
  };

  return { onError };
}
