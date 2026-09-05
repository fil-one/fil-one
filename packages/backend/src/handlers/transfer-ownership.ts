import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { OrgRole, TransferOwnershipSchema, canManageTargetRole } from '@filone/shared';
import type { AccessKeySummary, ErrorResponse, TransferOwnershipResponse } from '@filone/shared';
import { AuditSubjects, userActor } from '../lib/audit.js';
import { commitAfterRevokingKeys } from '../lib/commit-after-revoking-keys.js';
import { notifyRevokedKeys } from '../lib/key-revocation-email.js';
import { reviewMemberAccessKeysForRole } from '../lib/member-keys.js';
import { pendingInvitationsFrom, planRevocations, revokeDeferred } from '../lib/invitations.js';
import type { InvitationRecord } from '../lib/invitations.js';
import {
  cancelledLabels,
  labelled,
  ownerCountItem,
  roleChangeItems,
  withInvitationRevocations,
} from '../lib/membership-changes.js';
import type { LabelledItems } from '../lib/membership-changes.js';
import { readOwnerCount, resolveMembership } from '../lib/org-membership.js';
import {
  OrgDeletingError,
  getOrgProfile,
  isGuardRejection,
  orgNotDeletingCheck,
} from '../lib/org-profile.js';
import type { OrgProfileItem } from '../lib/org-profile.js';
import { parseJsonBody } from '../lib/parse-json-body.js';
import {
  ResponseBuilder,
  notAMemberResponse,
  ownerCountUnavailableResponse,
  refusedKeysSubject,
} from '../lib/response-builder.js';
import type { ErrorWithRevokedKeys } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { requireMfaIfEnrolled } from '../middleware/require-mfa.js';

const SOURCE = 'transfer-ownership';

/**
 * POST /api/org/transfer — hand the Owner seat to another member.
 *
 * Owner-only (`org.transfer`), and the one org action behind a step-up: it is
 * the only verb that takes the caller's own authority away, so a session
 * somebody walked away from must not be enough to move the seat.
 * `requireMfaIfEnrolled` rather than `requireMfa`, because a user with nothing
 * enrolled would otherwise be denied outright rather than prompted — the gate
 * asks for a recent authentication, which everyone can produce.
 *
 * The target comes from the body rather than the path, so this is the one
 * member verb that cannot open with `requireManageableMember`; its own ceiling
 * is `authorize`'s, since only an Owner reaches here and an Owner reaches
 * everyone.
 *
 * The transaction opens with the org-deletion fence, which is what stops the
 * inverse items' deliberately unconditional updates from recreating memberships
 * a teardown has already walked past (`lib/membership-changes.ts`).
 *
 * The promotion and the demotion are one transaction, and the owner count moves
 * by nothing: the org has exactly one Owner before and after. The net-zero update
 * still writes, because touching the META row is what puts it in the
 * transaction — a promotion landing concurrently then conflicts instead of
 * interleaving with a swap that assumed the count.
 *
 * The outgoing Owner's pending Owner-invitations ride the same transaction, the
 * way a demotion's do: they are invitations the role they now hold could not
 * have issued.
 *
 * Nothing about billing changes. The subscription is keyed to the org and the
 * Stripe customer is untouched; ownership is a role attribute, not a payer.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId, userId, membership } = getUserInfo(event);
  const actorEmail = getVerifiedEmail(event);

  const parsed = parseJsonBody(event.body, TransferOwnershipSchema);
  if ('error' in parsed) return parsed.error;
  const targetUserId = parsed.data.userId;

  if (targetUserId === userId) return alreadyOwnerResponse();

  const target = await resolveMembership(orgId, targetUserId);
  if (!target) return notAMemberResponse();
  if (target.role === OrgRole.Owner) return alreadyOwnerResponse();

  // The same sweep a demotion runs, for the same reason: the outgoing Owner
  // becomes an Admin, and an Admin cannot issue an Owner invitation, so they
  // cannot keep one outstanding either. The accept path's ConditionCheck already
  // refuses those links, which makes this hygiene rather than a guard — no dead
  // links in inboxes, no slots held under the cap, no pending rows on the page
  // that nobody can explain.
  const invitationsToRevoke = (await pendingInvitationsFrom(orgId, userId)).filter(
    (invitation) => !canManageTargetRole(OrgRole.Admin, invitation.role),
  );
  // `authorize('org.transfer')` is Owner-only, so this is the caller's role.
  const base = transferBase({ orgId, userId, callerRole: membership!.role, target });
  const { now, later } = planRevocations(invitationsToRevoke, base.items.length);
  const change = withInvitationRevocations(base, now);

  // Transfer is the role change the outgoing Owner undergoes, so it runs the
  // same pass a demotion does: an Admin cannot hold a key carrying
  // `PutObjectRetention` or `PutObjectLegalHold`, and one they already hold
  // would outlive the authority that minted it.
  // The transaction bumps `ownerCount` even though the owner set does not move,
  // and that update conditions on the attribute existing. A counter that cannot
  // be read therefore cancels the transfer, so it is refused here rather than
  // after the outgoing Owner's keys are already gone — and the remedy is support
  // rather than a retry, since the org's META row needs repairing.
  if ((await readOwnerCount(orgId)) === undefined) {
    console.error('[transfer-ownership] ownerCount missing — transfer refused', { orgId });
    return ownerCountUnavailableResponse('read');
  }

  const orgProfile = await getOrgProfile(orgId);
  const review = await reviewMemberAccessKeysForRole(orgId, userId, OrgRole.Admin);

  const committed = await commitAfterRevokingKeys({
    items: change.items,
    keys: review.keysToRevoke,
    orgId,
    orgProfile,
    actor: userActor({ userId, email: actorEmail }),
    trigger: 'role_narrowing',
    type: 'ownership.transferred',
    subject: AuditSubjects.org(orgId),
    details: {
      fromUserId: userId,
      toUserId: targetUserId,
      ...(invitationsToRevoke.length > 0 ? { revokedInvitations: invitationsToRevoke.length } : {}),
    },
    source: SOURCE,
    onCancelled: (err, revokedKeys) =>
      transferFailureResponse(err, { orgId, labels: change.labels, revokedKeys }),
    onRefused: (refused, revoked) => vendorRefusedResponse(revoked, refused),
    // No `notifyMember`: the keys that went are the caller's own, and the
    // refusal they are about to read names every one of them. A mail would tell
    // them what the screen in front of them already has.
  });
  if ('response' in committed) return committed.response;

  return await finishTransfer({
    orgId,
    orgProfile,
    userId,
    targetUserId,
    changedBy: actorEmail ?? userId,
    later,
    revoked: committed.revoked,
  });
}

/**
 * The tail once the seat has moved: the invitations that did not fit the
 * transaction, the outgoing Owner's email, and the answer.
 *
 * Nothing here can fail the request. The seat is where the caller put it, and
 * an error now would send them into a retry that answers already-owner, while
 * the thing that failed was a notification.
 *
 * The mail goes to the caller themselves: they are the one whose keys went, and
 * the console has already answered them. Sent anyway, because a client that
 * stops working between deploys is worth a durable record in an inbox.
 */
async function finishTransfer({
  orgId,
  orgProfile,
  userId,
  targetUserId,
  changedBy,
  later,
  revoked,
}: {
  orgId: string;
  orgProfile: OrgProfileItem | undefined;
  /** The outgoing Owner, who is also the caller. */
  userId: string;
  targetUserId: string;
  /** The caller, by verified email or by id, for their own email. */
  changedBy: string;
  /** The revoked invitations the transaction had no room for. */
  later: InvitationRecord[];
  revoked: AccessKeySummary[];
}): Promise<APIGatewayProxyStructuredResultV2> {
  await revokeDeferred(later);
  await notifyRevokedKeys({
    orgId,
    orgProfile,
    userId,
    changedBy,
    revoked,
    cause: { kind: 'role_changed', previousRole: OrgRole.Owner, role: OrgRole.Admin },
    source: SOURCE,
  });

  return new ResponseBuilder()
    .status(200)
    .body<TransferOwnershipResponse>({ userId: targetUserId, previousOwnerUserId: userId })
    .build();
}

/**
 * The fence, both role changes and the counter — what the sweep's revocations
 * sit behind. Labelled so a cancellation names the item, and so the count the
 * sweep plans around is read off the list rather than kept in step by hand.
 */
function transferBase({
  orgId,
  userId,
  callerRole,
  target,
}: {
  orgId: string;
  userId: string;
  callerRole: OrgRole;
  target: { userId: string; role: OrgRole };
}): LabelledItems {
  const [promotion, promotionInverse] = roleChangeItems({
    orgId,
    userId: target.userId,
    fromRole: target.role,
    toRole: OrgRole.Owner,
  });
  const [demotion, demotionInverse] = roleChangeItems({
    orgId,
    userId,
    fromRole: callerRole,
    // The outgoing Owner stays, as an Admin: transferring the seat is not
    // leaving the org, and an org that loses its only administrator because
    // somebody handed over ownership is a support ticket.
    toRole: OrgRole.Admin,
  });

  return labelled([
    ['org', orgNotDeletingCheck(orgId)],
    ['promotion', promotion],
    ['promotionInverse', promotionInverse],
    ['demotion', demotion],
    ['demotionInverse', demotionInverse],
    ['ownerCount', ownerCountItem(orgId, 'unchanged')],
  ]);
}

/**
 * A vendor refused a revocation, so the seat has not moved and the keys already
 * revoked stay revoked. Retrying is the same POST, which finds fewer keys.
 */
function vendorRefusedResponse(
  revokedKeys: AccessKeySummary[],
  failedKeys: AccessKeySummary[],
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(502)
    .body<ErrorWithRevokedKeys>({
      message: `${refusedKeysSubject(failedKeys)} could not be revoked, so ownership has not moved. Try again.`,
      revokedKeys,
    })
    .build();
}

/**
 * The answer when the transfer transaction cancels. Whatever the seat now says,
 * the keys named in `revokedKeys` are gone, and the caller is the person who
 * held them, so the refusal has to carry them.
 */
function transferFailureResponse(
  err: unknown,
  {
    orgId,
    labels,
    revokedKeys,
  }: { orgId: string; labels: string[]; revokedKeys: AccessKeySummary[] },
): APIGatewayProxyStructuredResultV2 {
  // The fence, at its own index: the org is being torn down and no retry helps.
  if (isGuardRejection(err)) throw new OrgDeletingError(orgId);

  const failed = cancelledLabels(err, labels);
  if (failed.length === 0) throw err;

  console.warn('[transfer-ownership] Transfer cancelled', { failed });
  return new ResponseBuilder()
    .status(409)
    .body<ErrorWithRevokedKeys>({
      message: 'The organization’s roles changed while the transfer was in flight — try again.',
      revokedKeys,
    })
    .build();
}

function alreadyOwnerResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({ message: 'That member already owns this organization.' })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('org.transfer'))
  .use(requireMfaIfEnrolled())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
