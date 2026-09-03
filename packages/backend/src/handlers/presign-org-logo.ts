import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PresignOrgLogoSchema } from '@filone/shared';
import type { PresignOrgLogoResponse } from '@filone/shared';
import { presignOrgLogoUpload } from '../lib/org-logo-storage.js';
import { parseJsonBody } from '../lib/parse-json-body.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireOrgMembershipMiddleware } from '../middleware/authorize.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

/**
 * POST /api/org/logo-upload-url — a place to put an org logo before the org it
 * belongs to exists.
 *
 * "Create organization" uploads the logo the caller picks before the org is
 * created, since the dialog wants to show it as soon as it is chosen. There is
 * no org yet to hold a role in, so this route carries no `authorize()` gate —
 * `requires: 'in-handler'` in the route manifest, the same category
 * `create-org` uses, both for the same reason: any authenticated member of
 * some org may ask for a place to put a picture, and nothing about a role
 * decides that.
 *
 * The body says only the content type; the client PUTs the file straight to
 * the returned `uploadUrl`, and hands the returned `logoUrl` to `POST
 * /api/org` unchanged. This handler never sees the bytes.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const parsed = parseJsonBody(event.body, PresignOrgLogoSchema);
  if ('error' in parsed) return parsed.error;

  const { uploadUrl, logoUrl } = await presignOrgLogoUpload({
    contentType: parsed.data.contentType,
  });

  return new ResponseBuilder()
    .status(200)
    .body<PresignOrgLogoResponse>({ uploadUrl, logoUrl })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  // No `authorize()`: there is no org here to hold a role in. Membership in
  // the caller's own active org is still asked for, the same floor every
  // `in-handler` route stands on — an authenticated session with no org at
  // all is not a shape any account reaches today.
  .use(requireOrgMembershipMiddleware())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
