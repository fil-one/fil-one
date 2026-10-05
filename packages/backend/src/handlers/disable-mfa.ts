import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ErrorResponse } from '@filone/shared';
import { ResponseBuilder } from '../lib/response-builder.ts';
import { deleteAllAuthenticators, getMfaEnrollments } from '../lib/auth0-management.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import { requireMfa } from '../middleware/require-mfa.ts';

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { sub } = getUserInfo(event);

  const enrollments = await getMfaEnrollments(sub);
  if (enrollments.length === 0) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'MFA is not currently enabled.' })
      .build();
  }

  await deleteAllAuthenticators(sub, enrollments);

  return new ResponseBuilder().status(200).body({ message: 'MFA has been disabled.' }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(requireMfa())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
