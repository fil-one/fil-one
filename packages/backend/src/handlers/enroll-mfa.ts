import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { ResponseBuilder } from '../lib/response-builder.js';
import {
  deleteAuthenticationMethod,
  flagMfaEnrollment,
  getMfaEnrollments,
  setEmailMfaActive,
} from '../lib/auth0-management.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { sub } = getUserInfo(event);

  // Remove any email factor before enrolling a strong factor. Email is only
  // allowed as the sole MFA method (it shares a channel with password reset),
  // so once a strong factor is added it must not remain.
  const enrollments = await getMfaEnrollments(sub, { includeEmail: true });
  let removedEmail = false;
  for (const enrollment of enrollments) {
    if (enrollment.type === 'email') {
      await deleteAuthenticationMethod(sub, enrollment.id);
      removedEmail = true;
    }
  }
  // Clear the opt-in flag if we removed an email factor — leaving it set
  // would let the Post-Login Action re-treat the auto-enrolled email factor
  // as a real one once the strong factor is later removed.
  if (removedEmail) {
    await setEmailMfaActive(sub, false);
  }

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
