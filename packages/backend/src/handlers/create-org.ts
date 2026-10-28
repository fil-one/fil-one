import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { CreateOrgSchema, MAX_OWNED_ORGS, OrgRole } from '@filone/shared';
import type { CreateOrgResponse, ErrorResponse } from '@filone/shared';
import { createAdditionalOrg } from '../lib/account-creation.ts';
import { SanitizedOrgNameSchema } from '../lib/org-name-validation.ts';
import { isUploadedOrgLogoUrl, withClaimedOrgLogo } from '../lib/org-logo-storage.ts';
import { listMemberships } from '../lib/org-membership.ts';
import { parseJsonBody } from '../lib/parse-json-body.ts';
import { ResponseBuilder } from '../lib/response-builder.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { requireOrgMembershipMiddleware } from '../middleware/authorize.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';

/**
 * The wire shape with the stored shape's sanitization folded in, so one parse
 * produces the value that gets written — the same reasoning `update-org.ts`
 * gives `UpdateOrgBodySchema`.
 */
const CreateOrgBodySchema = CreateOrgSchema.extend({ name: SanitizedOrgNameSchema });

/**
 * POST /api/org — an existing account creating an additional organization.
 *
 * Membership-only, with no `authorize(permission)`: see the `'in-handler'` doc
 * in `route-manifest.ts`.
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

  // A ceiling on how many orgs one account can stand up, so a loop against this
  // route can't mint orgs without bound. Read before the write rather than
  // inside it, so two concurrent creates at the limit can both land; that
  // overshoot is bounded by the caller's own concurrency.
  const memberships = await listMemberships(userId);
  const owned = memberships.filter((m) => m.role === OrgRole.Owner).length;
  if (owned >= MAX_OWNED_ORGS) {
    return new ResponseBuilder()
      .status(409)
      .body<ErrorResponse>({
        message: `You can own up to ${MAX_OWNED_ORGS} organizations. Contact support if you need more.`,
      })
      .build();
  }

  // `logoUrl` is client-supplied, so its only trust is being a URL the
  // presign step actually minted — never a caller-chosen host that every
  // member's browser would then be made to contact.
  if (logoUrl !== undefined && !(await isUploadedOrgLogoUrl(logoUrl))) {
    return new ResponseBuilder()
      .status(400)
      .body<ErrorResponse>({
        message: 'logoUrl must be a URL returned by the logo upload endpoint',
      })
      .build();
  }

  // The logo is claimed before the org points at it, and a create that fails
  // puts the claim back, so retrying with the same logo still passes the check.
  const create = () => createAdditionalOrg({ userId, orgName: name, logoUrl, email });
  const created =
    logoUrl === undefined ? await create() : await withClaimedOrgLogo(logoUrl, create);

  return new ResponseBuilder()
    .status(201)
    .body<CreateOrgResponse>({
      orgId: created.orgId,
      orgName: created.orgName,
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
