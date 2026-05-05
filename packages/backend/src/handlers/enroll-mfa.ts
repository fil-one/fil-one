import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { ResponseBuilder } from '../lib/response-builder.js';
import { flagMfaEnrollment } from '../lib/auth0-management.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { sub } = getUserInfo(event);

  // Flag the user for enrollment. The Post-Login Action will detect
  // this flag and trigger MFA enrollment via Universal Login. Multiple
  // strong factors are allowed — clicking "Add authenticator or key"
  // again enrolls an additional factor.
  await flagMfaEnrollment(sub);

  return new ResponseBuilder()
    .status(200)
    .body({ message: 'Redirecting to enroll your authenticator.' })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
