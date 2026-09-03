import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { OrgRole } from '@filone/shared';
import type { AccessKeySummary } from '@filone/shared';
import { AuditSubjects, userActor } from '../lib/audit.js';
import { commitAfterRevokingKeys } from '../lib/commit-after-revoking-keys.js';
import { notifyRevokedKeys } from '../lib/key-revocation-email.js';
import { reviewRemovedMemberAccessKeys } from '../lib/member-keys.js';
import { requireManageableMember } from '../lib/manageable-member.js';
import { getOrgProfile } from '../lib/org-profile.js';
import type { OrgProfileItem } from '../lib/org-profile.js';
import {
  normalizeInviteEmail,
  pendingInvitationsForRemoval,
  planRevocations,
  retireInvitationItems,
  revokeDeferred,
} from '../lib/invitations.js';
import type { InvitationRecord } from '../lib/invitations.js';
import {
  cancelledLabels,
  membershipDeleteItems,
  ownerCountItem,
} from '../lib/membership-changes.js';
import { readOwnerCount, resolveMembership } from '../lib/org-membership.js';
import { readUserProfile } from '../lib/user-profile.js';
import {
  ResponseBuilder,
  invitationRaceResponse,
  lastOwnerResponse,
  memberRoleChangedResponse,
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

const SOURCE = 'remove-member';

/**
 * The way out of a last-Owner refusal, for somebody removing an Owner: unlike a
 * demotion, the seat can also be handed over.
 */
const LAST_OWNER_REMEDY = 'Transfer ownership or promote another member first.';

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
 * Removal is the narrowing to nothing: a key does not outlive the membership
 * that created it, so every attributed key the member minted is revoked at its
 * orchestrator before the membership rows go (`lib/commit-after-revoking-keys.ts`).
 * Rows with no recorded creator are outside the rule, as they are outside every
 * other, and FIL-1021's per-key review is confined to those.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId, userId } = getUserInfo(event);
  const actorEmail = getVerifiedEmail(event);

  const gate = await requireManageableMember(event, { kind: 'removal' });
  if (!gate.ok) return gate.refusal;
  const target = gate.value;
  const targetUserId = target.userId;

  const wasOwner = target.role === OrgRole.Owner;
  const invitationsToRevoke = await pendingInvitationsForRemoval(orgId, {
    userId: targetUserId,
    emailNorm: await removedMemberAddress(targetUserId),
  });
  const { now, later } = planRevocations(invitationsToRevoke, wasOwner ? 3 : 2);

  // Every local precondition that can refuse the removal is checked before a
  // key is touched, since a revocation cannot be undone. The last-Owner guard
  // is the decrement's own condition, so it is read here rather than waited for,
  // and a counter that cannot be read refuses on the same ground: the decrement
  // conditions on `ownerCount`, so a missing META row cancels the transaction
  // just the same and the removal would end with the member still here and
  // their credentials gone.
  if (wasOwner) {
    const owners = await readOwnerCount(orgId);
    if (owners === 1) return lastOwnerResponse(LAST_OWNER_REMEDY);
    if (owners === undefined) return refuseWithoutOwnerCount(orgId);
  }

  const items = [
    ...membershipDeleteItems({ orgId, userId: targetUserId, fromRole: target.role }),
    ...(wasOwner ? [ownerCountItem(orgId, 'decrement')] : []),
    ...now.flatMap((invitation) => retireInvitationItems(invitation, 'revoked')),
  ];
  const failure = { orgId, targetUserId, wasOwner, revocations: now.length };

  const orgProfile = await getOrgProfile(orgId);
  const review = await reviewRemovedMemberAccessKeys(orgId, targetUserId);
  const changedBy = actorEmail ?? userId;

  const committed = await commitAfterRevokingKeys({
    items,
    keys: review.keysToRevoke,
    orgId,
    orgProfile,
    actor: userActor({ userId, email: actorEmail }),
    trigger: 'member_removed',
    type: 'member.removed',
    subject: AuditSubjects.user(targetUserId),
    details: {
      role: target.role,
      ...(invitationsToRevoke.length > 0 ? { revokedInvitations: invitationsToRevoke.length } : {}),
    },
    source: SOURCE,
    onCancelled: (err, revokedKeys) => removalFailureResponse(err, { ...failure, revokedKeys }),
    onRefused: (refused, revoked) => vendorRefusedResponse(revoked, refused),
    // The member is still here with their clients already broken. The caller
    // sees it in the response; this is the only thing that reaches the member.
    notifyMember: (revoked) =>
      notifyRevokedKeys({
        orgId,
        orgProfile,
        userId: targetUserId,
        changedBy,
        revoked,
        cause: { kind: 'change_failed' },
        source: SOURCE,
      }),
  });
  if ('response' in committed) return committed.response;

  return await finishRemoval({
    orgId,
    orgProfile,
    targetUserId,
    changedBy,
    later,
    revoked: committed.revoked,
  });
}

/**
 * The tail once the rows are gone: the invitations that did not fit the
 * transaction, the member's email, and the answer.
 *
 * Nothing here can fail the request. The member is out, and an error now would
 * send the caller into a retry that answers 404, while the thing that failed
 * was a notification.
 */
async function finishRemoval({
  orgId,
  orgProfile,
  targetUserId,
  changedBy,
  later,
  revoked,
}: {
  orgId: string;
  orgProfile: OrgProfileItem | undefined;
  targetUserId: string;
  /** The admin, by verified email or by id, for the member's email. */
  changedBy: string;
  /** The revoked invitations the transaction had no room for. */
  later: InvitationRecord[];
  revoked: AccessKeySummary[];
}): Promise<APIGatewayProxyStructuredResultV2> {
  await revokeDeferred(later);
  await notifyRevokedKeys({
    orgId,
    orgProfile,
    userId: targetUserId,
    changedBy,
    revoked,
    cause: { kind: 'removed' },
    source: SOURCE,
  });

  return { statusCode: 204, body: '' };
}

/**
 * A vendor refused a revocation, so the member is still in the org and the keys
 * already revoked stay revoked. Retrying is the same DELETE, which finds fewer
 * keys.
 */
function vendorRefusedResponse(
  revokedKeys: AccessKeySummary[],
  failedKeys: AccessKeySummary[],
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(502)
    .body<ErrorWithRevokedKeys>({
      message: `${refusedKeysSubject(failedKeys)} could not be revoked, so the member is still in this organization. Try again.`,
      revokedKeys,
    })
    .build();
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

/** What a cancelled removal needs to tell one refusal from another. */
interface RemovalFailure {
  orgId: string;
  targetUserId: string;
  wasOwner: boolean;
  revocations: number;
  /**
   * Keys the pass already revoked. They are gone whatever the membership now
   * says, so every refusal below carries them: a removal that cancels after a
   * revocation leaves a member in the org whose clients have stopped working,
   * and an answer that mentions only the membership hides that.
   */
  revokedKeys: AccessKeySummary[];
}

async function removalFailureResponse(
  err: unknown,
  { orgId, targetUserId, wasOwner, revocations, revokedKeys }: RemovalFailure,
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
      ? refuseWithoutOwnerCount(orgId, revokedKeys)
      : lastOwnerResponse(LAST_OWNER_REMEDY, revokedKeys);
  }
  if (failed.includes('invitation')) return invitationRaceResponse(revokedKeys);
  // The membership delete carries both the row's existence and its role, so a
  // cancellation here is one of two things and the row says which: gone, which
  // is the outcome the caller wanted, or still there under a role somebody
  // changed while this was in flight — and that one must not read as removed,
  // because the transaction's owner-count delta was decided from the old role.
  return (await resolveMembership(orgId, targetUserId))
    ? memberRoleChangedResponse('while the removal was in flight — try again', revokedKeys)
    : notAMemberResponse(revokedKeys);
}

/** Loud, because the org needs its META row repaired before an Owner can leave. */
function refuseWithoutOwnerCount(
  orgId: string,
  revokedKeys?: AccessKeySummary[],
): APIGatewayProxyStructuredResultV2 {
  console.error('[remove-member] ownerCount missing — removal of an Owner refused', { orgId });
  return ownerCountUnavailableResponse('updated', revokedKeys);
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('members.manage'))
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
