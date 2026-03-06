import type { MiddlewareObj } from '@middy/core';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import type { Request } from '@middy/core';
import { CSRF_COOKIE_NAME } from '@hyperspace/shared';
import type { ErrorResponse } from '@hyperspace/shared';
import { ResponseBuilder } from '../lib/response-builder.js';
import { parseCookies } from '../lib/cookies.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfMiddleware() {
  const before = async (
    request: Request<APIGatewayProxyEventV2, APIGatewayProxyResultV2, Error, Context>,
  ): Promise<APIGatewayProxyStructuredResultV2 | void> => {
    const method = request.event.requestContext.http.method;
    if (SAFE_METHODS.has(method)) return;

    const cookies = parseCookies(request.event.cookies);
    const cookieToken = cookies[CSRF_COOKIE_NAME];
    const headerToken = request.event.headers['x-csrf-token'];

    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      return new ResponseBuilder()
        .status(403)
        .body<ErrorResponse>({ message: 'CSRF validation failed' })
        .build();
    }
  };

  return { before } satisfies MiddlewareObj<APIGatewayProxyEventV2, APIGatewayProxyResultV2>;
}