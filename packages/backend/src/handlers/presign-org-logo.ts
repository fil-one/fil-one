import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PresignOrgLogoSchema } from '@filone/shared';
import type { PresignOrgLogoResponse } from '@filone/shared';
import { presignOrgLogoUpload } from '../lib/org-logo-storage.ts';
import { parseJsonBody } from '../lib/parse-json-body.ts';
import { ResponseBuilder, imageUploadRateLimitedResponse } from '../lib/response-builder.ts';
import { takeImageUploadPresign } from '../lib/image-upload-rate-limit.ts';
import { getUserInfo } from '../lib/user-context.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { requireOrgMembershipMiddleware } from '../middleware/authorize.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';

/**
 * POST /api/org/logo-upload-url — a place to put an org logo before the org it
 * belongs to exists.
 *
 * "Create organization" uploads the logo the caller picks before the org is
 * created, since the dialog wants to show it as soon as it is chosen.
 * Membership-only, like `create-org`: see the `'in-handler'` doc in
 * `route-manifest.ts`.
 *
 * Any member may ask, read-only included, and the bucket is public, so the
 * URLs one person can have are rate limited: past the limit this answers 429
 * rather than let the bucket serve as free hosting.
 *
 * The body says only the content type; the client POSTs the file straight to
 * the returned `uploadUrl`, and hands the returned `logoUrl` to `POST
 * /api/org` unchanged. This handler never sees the bytes.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const parsed = parseJsonBody(event.body, PresignOrgLogoSchema);
  if ('error' in parsed) return parsed.error;

  if (!(await takeImageUploadPresign(getUserInfo(event).userId))) {
    return imageUploadRateLimitedResponse();
  }

  const { uploadUrl, fields, logoUrl } = await presignOrgLogoUpload({
    contentType: parsed.data.contentType,
  });

  return new ResponseBuilder()
    .status(200)
    .body<PresignOrgLogoResponse>({ uploadUrl, fields, logoUrl })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(requireOrgMembershipMiddleware())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
