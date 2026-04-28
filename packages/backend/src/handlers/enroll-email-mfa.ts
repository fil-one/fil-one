import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ErrorResponse } from '@filone/shared';
import { ResponseBuilder } from '../lib/response-builder.js';
import { enrollEmailMfa, getMfaEnrollments } from '../lib/auth0-management.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { sub, email } = getUserInfo(event);

  if (!email) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'No verified email address found.' })
      .build();
  }

  // Auth0 Management API only allows adding email when no other factors exist.
  // This makes email a low-friction first MFA factor.
  const enrollments = await getMfaEnrollments(sub, { includeEmail: true });
  if (enrollments.length > 0) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({
        message: 'Email MFA can only be enabled when no other MFA methods are active.',
      })
      .build();
  }

  await enrollEmailMfa(sub, email);

  return new ResponseBuilder().status(200).body({ message: 'Email MFA has been enabled.' }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
