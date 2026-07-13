import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { DeletionChallengeResponse, ErrorResponse } from '@filone/shared';
import { ApiErrorCode } from '@filone/shared';
import { createDeletionChallenge } from '../lib/deletion-challenge.js';
import { readDeletionRecord } from '../lib/deletion-record.js';
import { sendDeletionCodeEmail } from '../lib/deletion-email.js';
import { getOrgProfile } from '../lib/org-profile.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { requireMfaIfEnrolled } from '../middleware/require-mfa.js';

/**
 * Issue the email verification challenge for account deletion (FIL-112).
 * No subscription guard: users in grace/canceled state must still be able
 * to delete their account. authMiddleware's verified-email default holds —
 * the code is only ever sent to the verified address.
 */
export async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { orgId, email } = getUserInfo(event);
  if (!email) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({ message: 'No email on the authenticated session' })
      .build();
  }

  if (await readDeletionRecord(orgId)) {
    return new ResponseBuilder()
      .status(409)
      .body<ErrorResponse>({ message: 'Account deletion is already in progress' })
      .build();
  }

  const challenge = await createDeletionChallenge(orgId);
  if (challenge.outcome === 'rate_limited') {
    return new ResponseBuilder()
      .status(429)
      .body<ErrorResponse & { resendAvailableAt: string }>({
        message: 'Too many verification codes requested. Please wait before retrying.',
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
    .body<DeletionChallengeResponse>({
      expiresAt: challenge.expiresAt,
      resendAvailableAt: challenge.resendAvailableAt,
    })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(requireMfaIfEnrolled())
  .use(errorHandlerMiddleware());
