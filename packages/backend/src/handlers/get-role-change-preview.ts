import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { auditKeyIdSuffix, isOrgRole } from '@filone/shared';
import type { AccessKeySummary, RoleChangePreviewResponse } from '@filone/shared';
import { requireManageableMember } from '../lib/manageable-member.js';
import { reviewMemberAccessKeysForRole } from '../lib/member-keys.js';
import type { AccessKeyToRevoke } from '../lib/member-keys.js';
import { ResponseBuilder, badRequestResponse } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
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
  const role = event.queryStringParameters?.role;
  if (!role || !isOrgRole(role)) return badRequestResponse('Ask about one of the org roles.');

  const gate = await requireManageableMember(event, { kind: 'role-change', toRole: role });
  if (!gate.ok) return gate.refusal;
  const target = gate.value;

  const review = await reviewMemberAccessKeysForRole(target.orgId, target.userId, role);

  // The PATCH answers a request for the role somebody already holds without
  // touching anything, so a preview of it promises the same: nothing revoked,
  // every key kept. Otherwise a key that already exceeds its holder's current
  // role, or one whose row records no permissions, would read as about to go by
  // a change that does nothing.
  if (target.role === role) {
    return previewResponse({
      currentRole: target.role,
      role,
      keys: [],
      retainedKeyCount: review.keysToRevoke.length + review.retainedKeyCount,
      unattributedKeyCount: review.unattributedKeyCount,
    });
  }

  return previewResponse({
    currentRole: target.role,
    role,
    keys: review.keysToRevoke.map(summarizeAccessKey),
    retainedKeyCount: review.retainedKeyCount,
    unattributedKeyCount: review.unattributedKeyCount,
  });
}

function previewResponse(body: RoleChangePreviewResponse): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder().status(200).body<RoleChangePreviewResponse>(body).build();
}

/**
 * A condemned key as the dialog lists it. The access key id is cut to the four
 * characters the console already shows, so a response that names somebody
 * else's credentials carries no more of them than the key list does.
 */
function summarizeAccessKey(key: AccessKeyToRevoke): AccessKeySummary {
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

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('members.manage'))
  .use(errorHandlerMiddleware());
