import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ErrorResponse } from '@filone/shared';
import { ResponseBuilder } from '../lib/response-builder.js';
import {
  deleteAuthenticationMethod,
  deleteEmailGuardianEnrollments,
  deleteGuardianEnrollment,
  getMfaEnrollments,
  setEmailMfaActive,
  updateAuth0User,
} from '../lib/auth0-management.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { sub } = getUserInfo(event);
  const enrollmentId = event.pathParameters?.enrollmentId;

  if (!enrollmentId) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Enrollment ID is required.' })
      .build();
  }

  // Verify the enrollment belongs to this user (include email enrollments)
  const enrollments = await getMfaEnrollments(sub, { includeEmail: true });
  const enrollment = enrollments.find((e) => e.id === enrollmentId);

  if (!enrollment) {
    return new ResponseBuilder()
      .status(404)
      .body<ErrorResponse>({ message: 'Enrollment not found.' })
      .build();
  }

  // Each enrollment carries the source endpoint it came from — Guardian and
  // /authentication-methods assign different ids for the same factor, so we
  // must delete via the matching endpoint.
  if (enrollment.source === 'guardian') {
    await deleteGuardianEnrollment(enrollmentId);
  } else {
    await deleteAuthenticationMethod(sub, enrollmentId);
  }

  // Email factors are mirrored into Guardian. The auth-methods delete does
  // not cascade, so sweep any orphan Guardian email rows or Auth0 keeps
  // challenging via email even though our settings page shows nothing. Also
  // clear the explicit-opt-in flag — otherwise the auto-enrolled email factor
  // (which Auth0 manufactures from email_verified) would re-trigger challenges.
  if (enrollment.type === 'email') {
    await deleteEmailGuardianEnrollments(sub);
    await setEmailMfaActive(sub, false);
  }

  // If this was the last MFA enrollment, clear the enrolling flag
  const remaining = enrollments.filter((e) => e.id !== enrollmentId);
  if (remaining.length === 0) {
    await updateAuth0User(sub, {
      app_metadata: { mfa_enrolling: false },
    });
  }

  return new ResponseBuilder().status(200).body({ message: 'MFA enrollment removed.' }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
