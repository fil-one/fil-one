import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { CreateOrgSchema, OrgRole } from '@filone/shared';
import type { CreateOrgResponse } from '@filone/shared';
import { createAdditionalOrg } from '../lib/account-creation.js';
import { SanitizedOrgNameSchema } from '../lib/org-name-validation.js';
import { parseJsonBody } from '../lib/parse-json-body.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireOrgMembershipMiddleware } from '../middleware/authorize.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

/**
 * The wire shape with the stored shape's sanitization folded in, so one parse
 * produces the value that gets written — the same reasoning `update-org.ts`
 * gives `UpdateOrgBodySchema`.
 */
const CreateOrgBodySchema = CreateOrgSchema.extend({ name: SanitizedOrgNameSchema });

/**
 * POST /api/org — an existing account creating an additional organization.
 *
 * Same path as `PATCH /api/org`, a different method — no collision, this is
 * ordinary REST. No `authorize(permission)`: the caller holds no role in the
 * org this request is about to create, so there is nothing for a permission
 * check to test against. `requires: 'in-handler'` in the route manifest marks
 * that, and `requireOrgMembershipMiddleware()` still asks that the caller
 * belong to *some* org — their own active one — which every account does from
 * the moment it exists.
 *
 * `logoUrl`, when present, must already be a URL `POST /api/org/logo-upload-url`
 * returned: this handler only ever persists the string, it never touches
 * storage.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { userId } = getUserInfo(event);
  const email = getVerifiedEmail(event);

  const parsed = parseJsonBody(event.body, CreateOrgBodySchema);
  if ('error' in parsed) return parsed.error;
  const { name, logoUrl } = parsed.data;

  const created = await createAdditionalOrg({ userId, orgName: name, logoUrl, email });

  return new ResponseBuilder()
    .status(201)
    .body<CreateOrgResponse>({
      orgId: created.orgId,
      orgName: created.orgName,
      slug: created.slug,
      role: OrgRole.Owner,
      ...(created.logoUrl ? { logoUrl: created.logoUrl } : {}),
    })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(requireOrgMembershipMiddleware())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
