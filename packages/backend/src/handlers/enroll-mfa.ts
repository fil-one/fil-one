import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { ResponseBuilder } from '../lib/response-builder.ts';
import { flagMfaEnrollment } from '../lib/auth0-management.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { sub } = getUserInfo(event);

  // Flag the user for enrollment. The Post-Login Action will detect
  // this flag and trigger MFA enrollment via Universal Login. Multiple
  // strong factors are allowed — clicking "Add authenticator or key"
  // again enrolls an additional factor.
  await flagMfaEnrollment(sub);

  return new ResponseBuilder().status(200).body({ message: 'Redirecting to enroll MFA.' }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
