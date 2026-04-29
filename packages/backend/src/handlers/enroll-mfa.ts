import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ErrorResponse } from '@filone/shared';
import { ResponseBuilder } from '../lib/response-builder.js';
import {
  deleteAuthenticationMethod,
  flagMfaEnrollment,
  getMfaEnrollments,
} from '../lib/auth0-management.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { sub } = getUserInfo(event);

  const enrollments = await getMfaEnrollments(sub, { includeEmail: true });
  const strongEnrollments = enrollments.filter((e) => e.type !== 'email');
  if (strongEnrollments.length > 0) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'MFA is already enabled.' })
      .build();
  }

  // If the user only has email MFA, remove it so the Post-Login Action
  // sees no enrolled factors and triggers strong-factor enrollment via
  // enrollWithAny. The UI confirms this replacement before calling.
  for (const enrollment of enrollments) {
    if (enrollment.type === 'email') {
      await deleteAuthenticationMethod(sub, enrollment.id);
    }
  }

  // Flag the user for enrollment. The Post-Login Action will detect
  // this flag and trigger MFA enrollment via Universal Login.
  await flagMfaEnrollment(sub);

  return new ResponseBuilder()
    .status(200)
    .body({ message: 'MFA enrollment flag set. Client should redirect to Auth0.' })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
