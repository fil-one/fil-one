import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import {
  ApiErrorCode,
  UpdateMemberRoleSchema,
  canChangeRole,
  canManageTargetRole,
} from '@filone/shared';
import type { ErrorResponse, OrgRole, UpdateMemberRoleResponse } from '@filone/shared';
import { AuditSubjects, auditEvent, commitAudited, userActor } from '../lib/audit.js';
import {
  pendingInvitationsFrom,
  planRevocations,
  retireInvitationItems,
  revokeDeferred,
} from '../lib/invitations.js';
import type { InvitationRecord } from '../lib/invitations.js';
import {
  cancelledLabels,
  ownerCountDeltaFor,
  ownerCountItem,
  roleChangeItems,
} from '../lib/membership-changes.js';
import { resolveMembership } from '../lib/org-membership.js';
import { parseJsonBody } from '../lib/parse-json-body.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

/**
 * PATCH /api/org/members/{userId} — move a member to another role.
 *
 * A role change is two reaches, at the member as they are and at the member as
 * they would be, so both clear the ceiling (`canChangeRole`): an Admin can
 * neither demote an Owner nor promote anyone to Owner, and either attempt is a
 * 403 rather than a partial change.
 *
 * One transaction carries all of it: both membership rows, the `ownerCount`
 * delta when the owner set moves, the pending invitations the member may no
 * longer issue, and the audit event. The last-Owner guard is the decrement's own
 * condition, which is why a PATCH cannot demote the last Owner — nothing here
 * checks for it, the counter does.
 *
 * Revoking invitations on the way down is the same rule the accept path's
 * `ConditionCheck` enforces, applied early: an invitation must not outlive its
 * issuer's authority. Only the ones the NEW role could not have issued are
 * revoked, so demoting an Owner to Admin retires their Owner invitations and
 * leaves the rest alone.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const targetUserId = event.pathParameters?.userId;
  if (!targetUserId) return badRequestResponse();

  const { orgId, userId, membership } = getUserInfo(event);
  const actorEmail = getVerifiedEmail(event);

  const parsed = parseJsonBody(event.body, UpdateMemberRoleSchema);
  if ('error' in parsed) return parsed.error;
  const { role } = parsed.data;

  const target = await resolveMembership(orgId, targetUserId);
  if (!target) return notAMemberResponse();

  // `authorize('members.manage')` refused every caller without a membership row.
  if (!canChangeRole(membership!.role, target.role, role)) {
    return beyondCeilingResponse(target.role, role);
  }

  // The console submits the form whether or not the select changed, and an
  // event saying a member went from Admin to Admin is noise in a log a customer
  // reads.
  if (target.role === role) {
    return roleResponse({ userId: targetUserId, role, previousRole: role });
  }

  const doomed = (await pendingInvitationsFrom(orgId, targetUserId)).filter(
    (invitation) => !canManageTargetRole(role, invitation.role),
  );
  const delta = ownerCountDeltaFor(target.role, role);
  const { now, later } = planRevocations(doomed, delta === 'unchanged' ? 2 : 3);

  try {
    await commitAudited({
      items: changeItems({ orgId, targetUserId, fromRole: target.role, toRole: role, now }),
      event: auditEvent({
        type: 'member.role_changed',
        actor: userActor({ userId, email: actorEmail }),
        orgId,
        subject: AuditSubjects.user(targetUserId),
        details: {
          role,
          previousRole: target.role,
          ...(doomed.length > 0 ? { revokedInvitations: doomed.length } : {}),
        },
      }),
    });
  } catch (err) {
    return changeFailureResponse(err, { delta, revocations: now.length });
  }

  await revokeDeferred(later);

  return roleResponse({ userId: targetUserId, role, previousRole: target.role });
}

function changeItems({
  orgId,
  targetUserId,
  fromRole,
  toRole,
  now,
}: {
  orgId: string;
  targetUserId: string;
  fromRole: OrgRole;
  toRole: OrgRole;
  now: InvitationRecord[];
}): TransactWriteItem[] {
  const delta = ownerCountDeltaFor(fromRole, toRole);

  return [
    ...roleChangeItems({ orgId, userId: targetUserId, fromRole, toRole }),
    ...(delta === 'unchanged' ? [] : [ownerCountItem(orgId, delta)]),
    ...now.flatMap((invitation) => retireInvitationItems(invitation, 'revoked')),
  ];
}

/**
 * The labels for those items, in the same order, so a cancellation names what
 * failed rather than a position.
 */
function changeLabels({
  delta,
  revocations,
}: {
  delta: ReturnType<typeof ownerCountDeltaFor>;
  revocations: number;
}): string[] {
  return [
    'membership',
    'inverse',
    ...(delta === 'unchanged' ? [] : ['ownerCount']),
    ...Array.from({ length: revocations * 2 }, () => 'invitation'),
  ];
}

function changeFailureResponse(
  err: unknown,
  context: { delta: ReturnType<typeof ownerCountDeltaFor>; revocations: number },
): APIGatewayProxyStructuredResultV2 {
  const failed = cancelledLabels(err, changeLabels(context));
  if (failed.length === 0) throw err;

  // The decrement's condition IS the last-Owner invariant: an org at one Owner
  // cancels the transaction that would take it to zero.
  if (failed.includes('ownerCount') && context.delta === 'decrement') return lastOwnerResponse();
  if (failed.includes('ownerCount')) return ownerCountUnavailableResponse();
  if (failed.includes('invitation')) return invitationRaceResponse();
  return concurrentChangeResponse();
}

function roleResponse(body: UpdateMemberRoleResponse): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder().status(200).body<UpdateMemberRoleResponse>(body).build();
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

function lastOwnerResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({
      message:
        'This organization would be left without an owner. Promote another member to owner first.',
      code: ApiErrorCode.LAST_OWNER,
    })
    .build();
}

function ownerCountUnavailableResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({
      message: 'The organization’s owner count could not be updated. Please contact support.',
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

function concurrentChangeResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({ message: 'That member’s role changed while you were editing it.' })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('members.manage'))
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
