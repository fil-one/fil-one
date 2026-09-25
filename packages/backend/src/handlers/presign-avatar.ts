import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PresignAvatarSchema } from '@filone/shared';
import type { PresignAvatarResponse } from '@filone/shared';
import { presignAvatarUpload } from '../lib/avatar-storage.ts';
import { parseJsonBody } from '../lib/parse-json-body.ts';
import { ResponseBuilder, imageUploadRateLimitedResponse } from '../lib/response-builder.ts';
import { takeImageUploadPresign } from '../lib/image-upload-rate-limit.ts';
import { getUserInfo } from '../lib/user-context.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';

/**
 * POST /api/me/avatar-upload-url — a place to put a personal avatar before
 * `PATCH /api/me/profile` persists it.
 *
 * The body says only the content type; the client POSTs the file straight to
 * the returned `uploadUrl` with the returned `fields`, and hands the returned
 * `pictureUrl` to `PATCH /api/me/profile` unchanged. This handler never sees
 * the bytes, same as `presign-org-logo`.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const parsed = parseJsonBody(event.body, PresignAvatarSchema);
  if ('error' in parsed) return parsed.error;

  // The bucket is public, so the upload URLs one person can have are limited,
  // the same way the logo endpoint's are.
  if (!(await takeImageUploadPresign(getUserInfo(event).userId))) {
    return imageUploadRateLimitedResponse();
  }

  const { uploadUrl, fields, pictureUrl } = await presignAvatarUpload({
    contentType: parsed.data.contentType,
  });

  return new ResponseBuilder()
    .status(200)
    .body<PresignAvatarResponse>({ uploadUrl, fields, pictureUrl })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
