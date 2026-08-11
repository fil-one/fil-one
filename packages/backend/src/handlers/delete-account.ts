import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { DeleteAccountResponse, ErrorResponse } from '@filone/shared';
import { ApiErrorCode, CSRF_COOKIE_NAME, DeleteAccountSchema } from '@filone/shared';
import { startAccountDeletion } from '../lib/account-deletion-start.js';
import { revokeRefreshToken } from '../lib/auth0-revoke.js';
import { parseCookies } from '../lib/cookies.js';
import { verifyDeletionChallenge } from '../lib/deletion-challenge.js';
import { isOrgAdmin } from '../lib/org-membership.js';
import { getOrgProfile } from '../lib/org-profile.js';
import { COOKIE_NAMES, makeClearAuthCookies, ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { requireMfaIfEnrolled } from '../middleware/require-mfa.js';

/**
 * Confirm account deletion (FIL-112). Validates the typed org name and the
 * emailed verification code, snapshots everything the async teardown worker
 * needs, kills every member session, and responds success immediately — the
 * worker (plus the reconciler cron) finishes the teardown in the background.
 * No subscription guard: grace/canceled users must still be able to delete.
 */
export async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { orgId, userId } = getUserInfo(event);

  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }
  const parsed = DeleteAccountSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, parsed.error.issues[0].message);
  }

  // Server-side type-to-confirm: the client gate alone is not trusted.
  const orgProfile = await getOrgProfile(orgId);
  const orgName = orgProfile?.name?.S?.trim() ?? '';
  if (parsed.data.orgName.trim() !== orgName || orgName === '') {
    return errorResponse(400, 'Organization name does not match');
  }

  if (!(await isOrgAdmin(orgId, userId))) {
    return errorResponse(403, 'Only an organization admin can delete the account');
  }

  const verify = await verifyDeletionChallenge(orgId, userId, parsed.data.code);
  if (verify === 'invalid') {
    return errorResponse(400, 'Incorrect verification code', ApiErrorCode.DELETION_CODE_INVALID);
  }
  if (verify === 'expired_or_locked') {
    return errorResponse(
      410,
      'Verification code expired or locked — request a new one',
      ApiErrorCode.DELETION_CODE_EXPIRED_OR_LOCKED,
    );
  }

  await startAccountDeletion(orgId, { requestedByUserId: userId, reason: 'self_serve' });

  // Best-effort: the worker deletes the Auth0 user shortly after, which
  // invalidates every other device's refresh token too.
  await revokeRefreshToken(
    parseCookies(event.cookies)[COOKIE_NAMES.REFRESH_TOKEN],
    '[delete-account]',
  );

  return successResponse();
}

function errorResponse(
  status: number,
  message: string,
  code?: ApiErrorCode,
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(status)
    .body<ErrorResponse>({ message, ...(code ? { code } : {}) })
    .build();
}

function successResponse(): APIGatewayProxyStructuredResultV2 {
  const builder = new ResponseBuilder()
    .status(200)
    .body<DeleteAccountResponse>({ message: 'Account deleted' });
  for (const cookie of makeClearAuthCookies(CSRF_COOKIE_NAME)) {
    builder.addCookie(cookie);
  }
  return builder.build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(requireMfaIfEnrolled())
  .use(errorHandlerMiddleware());
