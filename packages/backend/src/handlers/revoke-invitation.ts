import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiErrorCode, canManageTargetRole } from '@filone/shared';
import type { ErrorResponse } from '@filone/shared';
import { AuditSubjects, auditEvent, commitAudited, userActor } from '../lib/audit.js';
import { readInvitation, retireInvitationItems } from '../lib/invitations.js';
import { cancelledLabels } from '../lib/membership-changes.js';
import {
  ResponseBuilder,
  badRequestResponse,
  beyondCeilingResponse,
} from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

/**
 * DELETE /api/org/invitations/{inviteId} — withdraw an invitation.
 *
 * The ceiling is on the invitation's role, not on who issued it: an Admin
 * cannot revoke an Owner invitation for the same reason they cannot send one.
 * Whose invitation it was does not enter into it — `members.manage` is an
 * authority over the org's membership, not over one's own paperwork.
 *
 * Both writes travel with the audit event in one transaction, and the status
 * update is conditional on the invitation still being pending. That condition is
 * the whole race resolution: a revoke arriving as somebody accepts loses
 * cleanly and answers 409 rather than throwing a 500 or, worse, marking an
 * invitation revoked after it was used.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const inviteId = event.pathParameters?.inviteId;
  if (!inviteId) return badRequestResponse('Missing inviteId in path');

  const { orgId, userId, membership } = getUserInfo(event);
  const actorEmail = getVerifiedEmail(event);

  const invitation = await readInvitation(orgId, inviteId);
  // An expired invitation is still revocable: the row is what an operator sees
  // on the page, and taking it off that page is the point of the button.
  if (!invitation || invitation.status !== 'pending') return notFoundResponse();

  // `authorize('members.manage')` refused every caller without a membership row.
  if (!canManageTargetRole(membership!.role, invitation.role)) {
    return beyondCeilingResponse(`manage an invitation for ${invitation.role}`);
  }

  try {
    await commitAudited({
      items: retireInvitationItems(invitation, 'revoked'),
      event: auditEvent({
        type: 'invite.revoked',
        actor: userActor({ userId, email: actorEmail }),
        orgId,
        subject: AuditSubjects.invite(inviteId),
        details: { inviteId, email: invitation.email },
      }),
    });
  } catch (err) {
    // The status update is the only item with a condition, so a cancellation
    // naming it means the invitation stopped being pending while this request
    // was in flight — an accept that won.
    if (cancelledLabels(err, ['invitation', 'token']).includes('invitation')) {
      return acceptedFirstResponse();
    }
    throw err;
  }

  return { statusCode: 204, body: '' };
}

/**
 * Unknown, already accepted, already revoked: one answer. The console's remedy
 * is the same for all three — reload the list — and telling them apart would
 * describe an invitation to a caller the row no longer concerns.
 */
function notFoundResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(404)
    .body<ErrorResponse>({
      message: 'That invitation is no longer pending.',
      code: ApiErrorCode.INVITE_NOT_FOUND,
    })
    .build();
}

function acceptedFirstResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({
      message: 'That invitation was accepted before it could be revoked.',
      code: ApiErrorCode.INVITE_NOT_FOUND,
    })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('members.manage'))
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
