import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiErrorCode, OrgRole, canManageTargetRole } from '@filone/shared';
import type { ErrorResponse, OrgRole as Role } from '@filone/shared';
import { AuditSubjects, auditEvent, commitAudited, userActor } from '../lib/audit.js';
import {
  pendingInvitationsFrom,
  planRevocations,
  retireInvitationItems,
  revokeDeferred,
} from '../lib/invitations.js';
import {
  cancelledLabels,
  membershipDeleteItems,
  ownerCountItem,
} from '../lib/membership-changes.js';
import { resolveMembership } from '../lib/org-membership.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

/**
 * DELETE /api/org/members/{userId} — take a member out of the organization.
 *
 * Removal counts against the same ceiling as every other verb: an Admin reaches
 * Admin and below, and removing an Owner is `owners.manage`, exactly like
 * demoting one. Otherwise deletion would reach what demotion forbids.
 *
 * Self-removal goes through the same rules rather than around them, which has a
 * consequence worth stating: an Owner or Admin can remove themselves — and the
 * last Owner still cannot, because their own removal carries the guarded
 * decrement like anyone else's — while a Member or ReadOnly cannot, since
 * `members.manage` is what this route costs and their roles do not hold it.
 * "Leave this organization" for those two is a capability the matrix does not
 * grant in M1; it needs a product decision (a `members.leave` permission, or a
 * self-service carve-out) rather than a quiet exception here.
 *
 * One transaction: both membership rows, the `ownerCount` decrement when the
 * member was an Owner, every pending invitation they issued, and the event.
 *
 * Keys are untouched in M1. A departing member's access keys keep working until
 * somebody revokes them, which the console names in the confirmation dialog; the
 * revoke-by-default flow with per-key review is FIL-1021.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const targetUserId = event.pathParameters?.userId;
  if (!targetUserId) return badRequestResponse();

  const { orgId, userId, membership } = getUserInfo(event);
  const actorEmail = getVerifiedEmail(event);

  const target = await resolveMembership(orgId, targetUserId);
  if (!target) return notAMemberResponse();

  // `authorize('members.manage')` refused every caller without a membership row.
  if (!canManageTargetRole(membership!.role, target.role)) {
    return beyondCeilingResponse(target.role);
  }

  const wasOwner = target.role === OrgRole.Owner;
  // Every one of them: the member is leaving, so no role of theirs remains to
  // justify an invitation still in flight.
  const doomed = await pendingInvitationsFrom(orgId, targetUserId);
  const { now, later } = planRevocations(doomed, wasOwner ? 3 : 2);

  try {
    await commitAudited({
      items: [
        ...membershipDeleteItems({ orgId, userId: targetUserId }),
        ...(wasOwner ? [ownerCountItem(orgId, 'decrement')] : []),
        ...now.flatMap((invitation) => retireInvitationItems(invitation, 'revoked')),
      ],
      event: auditEvent({
        type: 'member.removed',
        actor: userActor({ userId, email: actorEmail }),
        orgId,
        subject: AuditSubjects.user(targetUserId),
        details: {
          role: target.role,
          ...(doomed.length > 0 ? { revokedInvitations: doomed.length } : {}),
        },
      }),
    });
  } catch (err) {
    return removalFailureResponse(err, { wasOwner, revocations: now.length });
  }

  await revokeDeferred(later);

  return { statusCode: 204, body: '' };
}

function removalFailureResponse(
  err: unknown,
  { wasOwner, revocations }: { wasOwner: boolean; revocations: number },
): APIGatewayProxyStructuredResultV2 {
  const failed = cancelledLabels(err, [
    'membership',
    'inverse',
    ...(wasOwner ? ['ownerCount'] : []),
    ...Array.from({ length: revocations * 2 }, () => 'invitation'),
  ]);
  if (failed.length === 0) throw err;

  // The decrement's own condition, which is the whole last-Owner invariant:
  // the org's only Owner cannot be removed, including by themselves.
  if (failed.includes('ownerCount')) return lastOwnerResponse();
  if (failed.includes('invitation')) return invitationRaceResponse();
  // The membership delete is conditional on the row existing, so this is a
  // member somebody else removed first — the outcome the caller wanted.
  return notAMemberResponse();
}

function badRequestResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(400)
    .body<ErrorResponse>({ message: 'Missing userId in path' })
    .build();
}

function notAMemberResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(404)
    .body<ErrorResponse>({ message: 'That person is not a member of this organization.' })
    .build();
}

function beyondCeilingResponse(role: Role): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(403)
    .body<ErrorResponse>({
      message: `Your role in this organization cannot remove a ${role}.`,
      code: ApiErrorCode.FORBIDDEN_ROLE,
    })
    .build();
}

function lastOwnerResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({
      message:
        'This organization would be left without an owner. Transfer ownership or promote another member first.',
      code: ApiErrorCode.LAST_OWNER,
    })
    .build();
}

function invitationRaceResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({
      message: 'An invitation from that member changed while this was in flight — try again.',
    })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('members.manage'))
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
