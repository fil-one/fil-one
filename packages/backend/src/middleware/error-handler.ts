import type { MiddlewareObj, Request } from '@middy/core';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import type { ErrorResponse } from '@hyperspace/shared';
import { ResponseBuilder } from '../lib/response-builder.js';

export function errorHandlerMiddleware(): MiddlewareObj<
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2
> {
  const onError = async (
    request: Request<APIGatewayProxyEventV2, APIGatewayProxyResultV2, Error, Context>,
  ): Promise<void> => {
    // Log the full error internally — never expose details to the caller
    console.error('Unhandled handler error:', request.error);

    request.response = new ResponseBuilder()
      .status(500)
      .body<ErrorResponse>({ message: 'An unexpected server error occurred. Please try again later.' })
      .build();
  };

  return { onError };
}
