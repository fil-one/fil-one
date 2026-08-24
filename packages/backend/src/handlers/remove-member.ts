import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiErrorCode, OrgRole, canManageTargetRole } from '@filone/shared';
import type { ErrorResponse, OrgRole as Role } from '@filone/shared';
import { AuditSubjects, auditEvent, commitAudited, userActor } from '../lib/audit.js';
import {
  normalizeInviteEmail,
  pendingInvitationsForRemoval,
  planRevocations,
  retireInvitationItems,
  revokeDeferred,
} from '../lib/invitations.js';
import {
  cancelledLabels,
  membershipDeleteItems,
  ownerCountItem,
} from '../lib/membership-changes.js';
import { readOwnerCount, resolveMembership } from '../lib/org-membership.js';
import { readUserProfile } from '../lib/user-profile.js';
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
 * member was an Owner, the invitations the removal retires, and the event.
 *
 * Two families of invitation go, and the second is the one that makes removal
 * mean anything. The ones they ISSUED go because no role of theirs remains to
 * justify them. The ones ADDRESSED TO them go because the token in such a link
 * still works: a removed member who kept an old invitation redeems it and walks
 * straight back in at the role that link carries — a stale Owner invitation
 * turns demote-then-remove into a re-entry as Owner. Nothing else on the accept
 * path refuses it, since their address still matches and the inviter still holds
 * the authority they invited with.
 *
 * Finding those needs the member's address, which the membership row does not
 * carry — it is in the `USER#{userId}/PROFILE` row, written by the two paths
 * that learn a verified one, and that read is best-effort like every other
 * profile read here. A removal whose profile read fails or whose row predates
 * those writers still removes the member, sweeps what they issued, and logs that
 * the addressed-to sweep could not run.
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
  const doomed = await pendingInvitationsForRemoval(orgId, {
    userId: targetUserId,
    emailNorm: await removedMemberAddress(targetUserId),
  });
  const { now, later } = planRevocations(doomed, wasOwner ? 3 : 2);

  try {
    await commitAudited({
      items: [
        ...membershipDeleteItems({ orgId, userId: targetUserId, fromRole: target.role }),
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
    return await removalFailureResponse(err, {
      orgId,
      targetUserId,
      wasOwner,
      revocations: now.length,
    });
  }

  await revokeDeferred(later);

  return { statusCode: 204, body: '' };
}

/**
 * The removed member's address, lowercased, or undefined when we do not hold
 * one.
 *
 * Held because the two paths that learn a verified address write it: account
 * creation and invitation acceptance (`lib/user-profile.ts`). So undefined is
 * now the rare answer — a row written before either did, or a read that failed
 * — rather than the only one, and it is worth a log line each time. It narrows
 * the sweep to the invitations the member issued: the invitation their old link
 * belongs to stays live until it expires, and an operator reading this line is
 * the only person who can revoke it by hand.
 */
async function removedMemberAddress(userId: string): Promise<string | undefined> {
  const email = (await readUserProfile(userId))?.email;
  if (!email) {
    console.error(
      '[remove-member] No address for the removed member — invitations to them stay live',
      { userId },
    );
    return undefined;
  }
  return normalizeInviteEmail(email);
}

async function removalFailureResponse(
  err: unknown,
  {
    orgId,
    targetUserId,
    wasOwner,
    revocations,
  }: { orgId: string; targetUserId: string; wasOwner: boolean; revocations: number },
): Promise<APIGatewayProxyStructuredResultV2> {
  const failed = cancelledLabels(err, [
    'membership',
    'inverse',
    ...(wasOwner ? ['ownerCount'] : []),
    ...Array.from({ length: revocations * 2 }, () => 'invitation'),
  ]);
  if (failed.length === 0) throw err;

  // The decrement's own condition, which is the whole last-Owner invariant:
  // the org's only Owner cannot be removed, including by themselves. Unless
  // there is no counter to read, in which case the guard did not fire — it was
  // never armed, and telling the caller they are the last Owner would be a
  // diagnosis of an org we cannot diagnose.
  if (failed.includes('ownerCount')) {
    return (await readOwnerCount(orgId)) === undefined
      ? ownerCountUnavailableResponse(orgId)
      : lastOwnerResponse();
  }
  if (failed.includes('invitation')) return invitationRaceResponse();
  // The membership delete carries both the row's existence and its role, so a
  // cancellation here is one of two things and the row says which: gone, which
  // is the outcome the caller wanted, or still there under a role somebody
  // changed while this was in flight — and that one must not read as removed,
  // because the transaction's owner-count delta was decided from the old role.
  return (await resolveMembership(orgId, targetUserId))
    ? roleChangedResponse()
    : notAMemberResponse();
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

/**
 * The org has membership rows and no counter, so the last-Owner invariant is
 * unenforceable for it until somebody repairs the META row — which the drift
 * checker does within a day. Loud, and the same answer the accept path gives for
 * the same missing row, because "contact support" is true and "you are the last
 * Owner" would not be.
 */
function ownerCountUnavailableResponse(orgId: string): APIGatewayProxyStructuredResultV2 {
  console.error('[remove-member] ownerCount missing — removal of an Owner refused', { orgId });
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({
      message: 'The organization’s owner count could not be updated. Please contact support.',
    })
    .build();
}

function roleChangedResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({
      message: 'That member’s role changed while the removal was in flight — try again.',
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
