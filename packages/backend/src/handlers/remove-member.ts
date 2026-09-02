import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiErrorCode, OrgRole, canManageTargetRole } from '@filone/shared';
import type { AuditActor, ErrorResponse, OrgRole as Role, RevokedKeySummary } from '@filone/shared';
import {
  AuditSubjects,
  auditEvent,
  commitAudited,
  twoPhaseAudit,
  userActor,
} from '../lib/audit.js';
import { sendKeyRevocationEmail } from '../lib/key-revocation-email.js';
import { keysOfRemovedMember } from '../lib/member-keys.js';
import type { DoomedKey } from '../lib/member-keys.js';
import { getOrgProfile } from '../lib/org-profile.js';
import type { OrgProfileItem } from '../lib/org-profile.js';
import { bestEffort, revokeMemberKeys } from '../lib/revoke-member-keys.js';
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
 * Removal is the narrowing to nothing: a key does not outlive the membership
 * that created it, so every attributed key the member minted is revoked at its
 * orchestrator before the membership rows go. Rows with no recorded creator are
 * outside the rule, as they are outside every other, and FIL-1021's per-key
 * review is confined to those.
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

  // Every local precondition that can refuse the removal is checked before a
  // key is touched, since a revocation cannot be undone. The last-Owner guard
  // is the decrement's own condition, so it is read here rather than waited for,
  // and a counter that cannot be read refuses on the same ground: the decrement
  // conditions on `ownerCount`, so a missing META row cancels the transaction
  // just the same and the removal would end with the member still here and
  // their credentials gone.
  if (wasOwner) {
    const owners = await readOwnerCount(orgId);
    if (owners === 1) return lastOwnerResponse();
    if (owners === undefined) return ownerCountUnavailableResponse(orgId);
  }

  const actor = userActor({ userId, email: actorEmail });
  const details = {
    role: target.role,
    ...(doomed.length > 0 ? { revokedInvitations: doomed.length } : {}),
  };
  const items = [
    ...membershipDeleteItems({ orgId, userId: targetUserId, fromRole: target.role }),
    ...(wasOwner ? [ownerCountItem(orgId, 'decrement')] : []),
    ...now.flatMap((invitation) => retireInvitationItems(invitation, 'revoked')),
  ];
  const failure = { orgId, targetUserId, wasOwner, revocations: now.length, revokedKeys: [] };

  const orgProfile = await getOrgProfile(orgId);
  const review = await keysOfRemovedMember(orgId, targetUserId);

  const removal = await takeTheSeatAway({
    orgId,
    orgProfile,
    targetUserId,
    actor,
    details,
    items,
    doomed: review.doomed,
    failure,
  });
  if ('response' in removal) return removal.response;

  await revokeDeferred(later);
  await tellTheRemovedMember({
    orgId,
    orgProfile,
    targetUserId,
    changedBy: actorEmail ?? userId,
    revoked: removal.revoked,
  });

  return { statusCode: 204, body: '' };
}

/**
 * Revoke every key the member minted, then take their rows away.
 *
 * The revocation happens at the orchestrator before the membership rows go, so
 * a credential never outlives the membership that authorized it. When the
 * member minted nothing the removal stays one transaction and one event, which
 * is what it has always been.
 */
async function takeTheSeatAway({
  orgId,
  orgProfile,
  targetUserId,
  actor,
  details,
  items,
  doomed,
  failure,
}: {
  orgId: string;
  orgProfile: OrgProfileItem | undefined;
  targetUserId: string;
  actor: AuditActor;
  details: { role: Role; revokedInvitations?: number };
  items: TransactWriteItem[];
  doomed: readonly DoomedKey[];
  failure: RemovalFailure;
}): Promise<{ revoked: RevokedKeySummary[] } | { response: APIGatewayProxyStructuredResultV2 }> {
  const event = (extra: { revokedKeys?: string[]; correlationId?: string }) =>
    extra.correlationId
      ? auditEvent({
          type: 'member.removed',
          actor,
          orgId,
          subject: AuditSubjects.user(targetUserId),
          details: { ...details, ...(extra.revokedKeys ? { revokedKeys: extra.revokedKeys } : {}) },
          phase: 'completion',
          correlationId: extra.correlationId,
          outcome: 'succeeded',
        })
      : auditEvent({
          type: 'member.removed',
          actor,
          orgId,
          subject: AuditSubjects.user(targetUserId),
          details,
        });

  if (doomed.length === 0) {
    try {
      await commitAudited({ items, event: event({}) });
    } catch (err) {
      return { response: await removalFailureResponse(err, failure) };
    }
    return { revoked: [] };
  }

  const notice = { orgId, orgProfile, targetUserId, changedBy: actor.email ?? actor.id };
  const removal = await twoPhaseAudit({
    type: 'member.removed',
    mode: 'fail-closed',
    actor,
    orgId,
    subject: AuditSubjects.user(targetUserId),
    details,
  });

  const first = await revokeMemberKeys({
    orgId,
    orgProfile,
    keys: doomed,
    actor,
    reason: 'member_removed',
  });
  const revokedKeys = first.revoked.map((key) => key.id);
  if (first.failed.length > 0) {
    await removal.complete({
      outcome: 'failed',
      ...(revokedKeys.length > 0 ? { details: { revokedKeys } } : {}),
    });
    // The member is still here, but the keys this pass did revoke are gone and
    // their clients are already broken. Both they and the caller hear about it.
    await tellAboutRevokedKeys(notice, first.revoked);
    return { response: vendorRefusedResponse(first.failed[0]!.keyName, first.revoked) };
  }

  try {
    await commitAudited({
      items,
      event: event({
        correlationId: removal.correlationId,
        ...(revokedKeys.length > 0 ? { revokedKeys } : {}),
      }),
    });
  } catch (err) {
    console.error('[remove-member] Removal failed after revoking keys', {
      orgId,
      revoked: revokedKeys.length,
    });
    // The member is still here and their clients have stopped working, so the
    // refusal names the keys rather than reading as an ordinary stale roster,
    // and the member is told the same way a failed narrowing tells them.
    await tellAboutRevokedKeys(notice, first.revoked);
    return {
      response: await removalFailureResponse(err, { ...failure, revokedKeys: first.revoked }),
    };
  }

  return { revoked: first.revoked };
}

/** The mail telling the member which of their keys stopped working. */
async function tellTheRemovedMember({
  orgId,
  orgProfile,
  targetUserId,
  changedBy,
  revoked,
}: {
  orgId: string;
  orgProfile: OrgProfileItem | undefined;
  targetUserId: string;
  changedBy: string;
  revoked: readonly RevokedKeySummary[];
}): Promise<void> {
  // The rows are gone by now, so this may not fail the request: the caller
  // would see an error for a removal that happened, and the retry answers 404.
  await bestEffort(
    () =>
      sendKeyRevocationEmail({
        userId: targetUserId,
        orgName: orgProfile?.name?.S ?? 'your organization',
        keys: revoked,
        cause: { kind: 'removed' },
        changedBy,
      }),
    undefined,
    { source: 'remove-member', orgId },
  );
}

/**
 * A vendor refused a revocation, so the member is still in the org and the keys
 * already revoked stay revoked. Retrying is the same DELETE, which finds fewer
 * keys.
 */
function vendorRefusedResponse(
  keyName: string,
  revokedKeys: RevokedKeySummary[],
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(502)
    .body<ErrorResponse & { revokedKeys: RevokedKeySummary[] }>({
      message: `The key "${keyName}" could not be revoked, so the member is still in this organization. Try again.`,
      revokedKeys,
    })
    .build();
}

/** Who to tell, and about which org. */
interface RevocationNotice {
  orgId: string;
  orgProfile: OrgProfileItem | undefined;
  targetUserId: string;
  changedBy: string;
}

/**
 * The member, told about keys that are gone even though they are still here.
 *
 * The keys are deleted at the orchestrator before the membership rows go, so a
 * refusal after that leaves them in the org with their clients already broken.
 * The caller sees it in the response; this is the only thing that reaches them.
 */
async function tellAboutRevokedKeys(
  { orgId, orgProfile, targetUserId, changedBy }: RevocationNotice,
  revoked: readonly RevokedKeySummary[],
): Promise<void> {
  await sendKeyRevocationEmail({
    userId: targetUserId,
    orgName: orgProfile?.name?.S ?? 'your organization',
    keys: revoked,
    cause: { kind: 'change_failed' },
    changedBy,
  }).catch((error: unknown) => {
    console.error('[remove-member] Could not tell the member their keys went', {
      orgId,
      targetUserId,
      error,
    });
  });
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
  revokedKeys: RevokedKeySummary[];
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
      ? ownerCountUnavailableResponse(orgId, revokedKeys)
      : lastOwnerResponse(revokedKeys);
  }
  if (failed.includes('invitation')) return invitationRaceResponse(revokedKeys);
  // The membership delete carries both the row's existence and its role, so a
  // cancellation here is one of two things and the row says which: gone, which
  // is the outcome the caller wanted, or still there under a role somebody
  // changed while this was in flight — and that one must not read as removed,
  // because the transaction's owner-count delta was decided from the old role.
  return (await resolveMembership(orgId, targetUserId))
    ? roleChangedResponse(revokedKeys)
    : notAMemberResponse(revokedKeys);
}

function badRequestResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(400)
    .body<ErrorResponse>({ message: 'Missing userId in path' })
    .build();
}

function notAMemberResponse(
  revokedKeys: RevokedKeySummary[] = [],
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(404)
    .body<ErrorResponse & { revokedKeys: RevokedKeySummary[] }>({
      message: 'That person is not a member of this organization.',
      revokedKeys,
    })
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

function lastOwnerResponse(
  revokedKeys: RevokedKeySummary[] = [],
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse & { revokedKeys: RevokedKeySummary[] }>({
      revokedKeys,
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
function ownerCountUnavailableResponse(
  orgId: string,
  revokedKeys: RevokedKeySummary[] = [],
): APIGatewayProxyStructuredResultV2 {
  console.error('[remove-member] ownerCount missing — removal of an Owner refused', { orgId });
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse & { revokedKeys: RevokedKeySummary[] }>({
      revokedKeys,
      message: 'The organization’s owner count could not be updated. Please contact support.',
    })
    .build();
}

function roleChangedResponse(
  revokedKeys: RevokedKeySummary[] = [],
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse & { revokedKeys: RevokedKeySummary[] }>({
      revokedKeys,
      message: 'That member’s role changed while the removal was in flight — try again.',
    })
    .build();
}

function invitationRaceResponse(
  revokedKeys: RevokedKeySummary[] = [],
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse & { revokedKeys: RevokedKeySummary[] }>({
      revokedKeys,
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
