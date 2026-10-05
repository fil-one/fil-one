import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ErrorResponse } from '@filone/shared';
import { ResponseBuilder } from '../lib/response-builder.ts';
import {
  deleteAuthenticationMethod,
  deleteGuardianEnrollment,
  deleteRecoveryCode,
  getMfaEnrollments,
  updateAuth0User,
} from '../lib/auth0-management.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';
import { requireMfa } from '../middleware/require-mfa.ts';

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { sub } = getUserInfo(event);
  const enrollmentId = event.pathParameters?.enrollmentId;

  if (!enrollmentId) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'Enrollment ID is required.' })
      .build();
  }

  const enrollments = await getMfaEnrollments(sub);
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

  // If this was the last MFA enrollment, also tear down the recovery code —
  // an orphaned recovery code remains valid and would let the holder sign in
  // with no second factor present — and clear the enrolling flag.
  const remaining = enrollments.filter((e) => e.id !== enrollmentId);
  if (remaining.length === 0) {
    await deleteRecoveryCode(sub);
    await updateAuth0User(sub, {
      app_metadata: { mfa_enrolling: false },
    });
  }

  return new ResponseBuilder().status(200).body({ message: 'MFA enrollment removed.' }).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(requireMfa())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
