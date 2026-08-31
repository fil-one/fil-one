import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiErrorCode } from '@filone/shared';
import type { ErrorResponse, RequestAccountDeletionResponse } from '@filone/shared';
import {
  isSelfServeDeletionEnabled,
  selfServeDeletionUnavailable,
} from '../lib/account-deletion-flag.js';
import { createDeletionChallenge } from '../lib/deletion-challenge.js';
import { sendDeletionCodeEmail } from '../lib/deletion-email.js';
import { getOrgProfile, isOrgDeleting } from '../lib/org-profile.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

/**
 * Issues the account-deletion verification code. Deliberately NOT behind
 * subscriptionGuardMiddleware: it blocks writes for cancelled and inactive
 * subscriptions, which is exactly the population most likely to be leaving.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!isSelfServeDeletionEnabled()) return selfServeDeletionUnavailable();

  const { orgId, userId } = getUserInfo(event);

  // Already confirmed: issuing another code would imply it can still be
  // stopped or re-authorized, and it cannot.
  if (await isOrgDeleting(orgId, { consistent: true })) {
    return new ResponseBuilder()
      .status(200)
      .body<RequestAccountDeletionResponse>({ outcome: 'deletion_in_progress' })
      .build();
  }

  const email = getVerifiedEmail(event);
  if (!email) {
    return new ResponseBuilder()
      .status(403)
      .body<ErrorResponse>({
        message: 'A verified email address is required to delete the organization.',
        code: ApiErrorCode.EMAIL_NOT_VERIFIED,
      })
      .build();
  }

  const challenge = await createDeletionChallenge(orgId, userId);
  if (challenge.outcome === 'rate_limited') {
    return new ResponseBuilder()
      .status(429)
      .body<ErrorResponse & { resendAvailableAt: string }>({
        message: 'A code was sent recently. Please wait before requesting another.',
        code: ApiErrorCode.DELETION_RATE_LIMITED,
        resendAvailableAt: challenge.resendAvailableAt,
      })
      .build();
  }

  const orgProfile = await getOrgProfile(orgId);
  await sendDeletionCodeEmail({
    to: email,
    orgName: orgProfile?.name?.S ?? 'your organization',
    code: challenge.code,
  });

  return new ResponseBuilder()
    .status(200)
    .body<RequestAccountDeletionResponse>({
      outcome: 'challenge_created',
      expiresAt: challenge.expiresAt,
      resendAvailableAt: challenge.resendAvailableAt,
    })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('org.delete'))
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
