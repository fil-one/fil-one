import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiErrorCode, auditKeyIdSuffix, canChangeRole, isOrgRole } from '@filone/shared';
import type {
  ErrorResponse,
  OrgRole,
  RevokedKeySummary,
  RoleChangePreviewResponse,
} from '@filone/shared';
import { keysExceedingRole } from '../lib/member-keys.js';
import type { DoomedKey } from '../lib/member-keys.js';
import { resolveMembership } from '../lib/org-membership.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

/**
 * GET /api/org/members/{userId}/role-change-preview?role= — the keys the PATCH
 * would revoke.
 *
 * An access key carries its own permission set, stamped when it was minted and
 * unchangeable afterwards, so a member who moves to a narrower role keeps
 * whatever their keys already hold. The PATCH revokes the ones they could no
 * longer mint. This says which, so an admin confirms a change they can see the
 * consequences of, and so the member can be told to mint a replacement first.
 *
 * The same gate and the same ceiling as the PATCH. It names another member's
 * access keys, and anybody who could not change that member's role has no
 * business reading them.
 *
 * Nothing here is a promise. The commit revokes from a fresh read, so a key
 * minted between this call and the PATCH is revoked too, and the PATCH's own
 * answer is what happened.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const targetUserId = event.pathParameters?.userId;
  if (!targetUserId) return badRequestResponse('Missing userId in path');

  const role = event.queryStringParameters?.role;
  if (!role || !isOrgRole(role)) return badRequestResponse('Ask about one of the org roles.');

  const { orgId, membership } = getUserInfo(event);

  const target = await resolveMembership(orgId, targetUserId);
  if (!target) return notAMemberResponse();

  // `authorize('members.manage')` refused every caller without a membership row.
  if (!canChangeRole(membership!.role, target.role, role)) {
    return beyondCeilingResponse(target.role, role);
  }

  const review = await keysExceedingRole(orgId, targetUserId, role);

  return new ResponseBuilder()
    .status(200)
    .body<RoleChangePreviewResponse>({
      currentRole: target.role,
      role,
      keys: review.doomed.map(summarizeKey),
      survivingCount: review.survivingCount,
      unattributedCount: review.unattributedCount,
    })
    .build();
}

/**
 * A condemned key as the dialog lists it. The access key id is cut to the four
 * characters the console already shows, so a response that names somebody
 * else's credentials carries no more of them than the key list does.
 */
function summarizeKey(key: DoomedKey): RevokedKeySummary {
  return {
    id: key.id,
    keyName: key.keyName,
    ...(key.accessKeyId ? { accessKeyIdSuffix: auditKeyIdSuffix('s3', key.accessKeyId) } : {}),
    region: key.region,
    createdAt: key.createdAt,
    reason: key.reason,
    excess: key.excess.map(({ keyPermission }) => keyPermission),
  };
}

function badRequestResponse(message: string): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder().status(400).body<ErrorResponse>({ message }).build();
}

function notAMemberResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(404)
    .body<ErrorResponse>({ message: 'That person is not a member of this organization.' })
    .build();
}

function beyondCeilingResponse(
  fromRole: OrgRole,
  toRole: OrgRole,
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(403)
    .body<ErrorResponse>({
      message: `Your role in this organization cannot change a ${fromRole} to ${toRole}.`,
      code: ApiErrorCode.FORBIDDEN_ROLE,
    })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('members.manage'))
  .use(errorHandlerMiddleware());
