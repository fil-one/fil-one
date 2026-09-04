import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PresignAvatarSchema } from '@filone/shared';
import type { PresignAvatarResponse } from '@filone/shared';
import { presignAvatarUpload } from '../lib/avatar-storage.js';
import { parseJsonBody } from '../lib/parse-json-body.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

/**
 * POST /api/me/avatar-upload-url — a place to put a personal avatar before
 * `PATCH /api/me/profile` persists it.
 *
 * The body says only the content type; the client PUTs the file straight to
 * the returned `uploadUrl`, and hands the returned `pictureUrl` to `PATCH
 * /api/me/profile` unchanged. This handler never sees the bytes, same as
 * `presign-org-logo`.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const parsed = parseJsonBody(event.body, PresignAvatarSchema);
  if ('error' in parsed) return parsed.error;

  const { uploadUrl, pictureUrl } = await presignAvatarUpload({
    contentType: parsed.data.contentType,
  });

  return new ResponseBuilder()
    .status(200)
    .body<PresignAvatarResponse>({ uploadUrl, pictureUrl })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
