import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { NO_ROLE, OrgRole } from '@filone/shared';
import type { AccessKeySummary, ErrorResponse, RemoveMemberResponse } from '@filone/shared';
import { AuditSubjects, auditPut, userActor } from '../lib/audit.ts';
import { prepareFloorOrg } from '../lib/account-creation.ts';
import type { FloorOrgPreparation } from '../lib/account-creation.ts';
import { commitAfterRevokingKeys } from '../lib/commit-after-revoking-keys.ts';
import { notifyRevokedKeys } from '../lib/key-revocation-email.ts';
import { reviewKeysForRoleChange } from '../lib/member-keys.ts';
import { requireManageableMember } from '../lib/manageable-member.ts';
import { getOrgProfile } from '../lib/org-profile.ts';
import type { OrgProfileItem } from '../lib/org-profile.ts';
import {
  normalizeInviteEmail,
  pendingInvitationsForRemoval,
  planRevocations,
  retireInvitationItems,
  revokeDeferred,
} from '../lib/invitations.ts';
import type { InvitationRecord } from '../lib/invitations.ts';
import {
  cancelledLabels,
  membershipDeleteItems,
  ownerCountItem,
} from '../lib/membership-changes.ts';
import { listMemberships, readOwnerCount, resolveMembership } from '../lib/org-membership.ts';
import type { OrgMembership } from '../lib/org-membership.ts';
import { readUserProfile, readUserSub } from '../lib/user-profile.ts';
import {
  ResponseBuilder,
  badRequestResponse,
  invitationRaceResponse,
  keyMintedResponse,
  lastOwnerResponse,
  memberRoleChangedResponse,
  notAMemberResponse,
  ownerCountUnavailableResponse,
  refusedKeysSubject,
} from '../lib/response-builder.ts';
import type { ErrorWithRevokedKeys } from '../lib/response-builder.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { requireOrgMembershipMiddleware, requirePermission } from '../middleware/authorize.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';

const SOURCE = 'remove-member';

/**
 * The way out of a last-Owner refusal, for somebody removing an Owner: unlike a
 * demotion, the seat can also be handed over.
 */
const LAST_OWNER_REMEDY = 'Transfer ownership or promote another member first.';

/**
 * DELETE /api/org/members/{userId} — take a member out of the organization,
 * or leave it yourself.
 *
 * Two different gates behind one route, decided in the handler because the
 * requirement depends on whether the path's `userId` names the caller:
 *
 * - **Removing someone else** costs `members.manage`, capped at the same
 *   ceiling as every other verb — an Admin reaches Admin and below, and
 *   removing an Owner is `owners.manage`, exactly like demoting one.
 *   Otherwise deletion would reach what demotion forbids.
 * - **Leaving** costs nothing beyond being a member: every role, including
 *   Member and ReadOnly (who hold no `members.manage`), may remove
 *   themselves. This is the self-service carve-out the route's own history
 *   flagged as a needed product decision rather than a quiet exception — a
 *   `members.leave` permission would only ever be granted to its own holder,
 *   so a carve-out states that directly instead of adding an entry to the
 *   matrix nothing else reads.
 *
 * Either way, the last Owner still cannot leave or be removed: that guard
 * lives in the `ownerCount` decrement's own condition below, unconditional on
 * who the caller is.
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
 *
 * A removal that would leave the target account with zero memberships instead
 * gives it a floor org in the same transaction ({@link prepareFloorOrg}):
 * every account needs somewhere to log in to, and lazily creating one only
 * when it would otherwise have none is cheaper than every invited account
 * carrying a personal org it may never use. Skipped for an account whose
 * profile carries no `sub` — nothing to repoint the identity row of — which
 * is logged loudly rather than blocking the removal itself.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId, userId } = getUserInfo(event);
  const actorEmail = getVerifiedEmail(event);

  const gate = await resolveRemovalTarget(event, {
    orgId,
    userId,
    targetUserId: event.pathParameters?.userId,
  });
  if (!gate.ok) return gate.refusal;
  const target = gate.target;
  // The confirmed id, narrowed from the path param `resolveRemovalTarget` has
  // already checked is present.
  const targetUserId = target.userId;

  const wasOwner = target.role === OrgRole.Owner;
  // One read, two answers: the address the invitation sweep matches on, and the
  // one a fence refusal names — an admin told "a key was created for that
  // member" cannot tell which of their members to go and look at.
  const targetProfile = await readUserProfile(targetUserId);
  const targetEmail = removedMemberAddress(targetUserId, targetProfile?.email);
  // Neither depends on the other's result, only on the profile just read, so
  // there is no reason to pay for their DynamoDB round-trips one after the
  // other.
  const [invitationsToRevoke, floorOrg] = await Promise.all([
    pendingInvitationsForRemoval(orgId, {
      userId: targetUserId,
      ...(targetEmail ? { emailNorm: normalizeInviteEmail(targetEmail) } : {}),
    }),
    prepareFloorOrgIfLastMembership({
      targetUserId,
      orgId,
      name: targetProfile?.name,
      email: targetProfile?.email,
    }),
  ]);
  const { now, later } = planRevocations(invitationsToRevoke, wasOwner ? 3 : 2);

  const refusal = await refuseBeforeRevokingKeys(orgId, wasOwner);
  if (refusal) return refusal;

  const items = [
    ...membershipDeleteItems({ orgId, userId: targetUserId, fromRole: target.role }),
    ...(wasOwner ? [ownerCountItem(orgId, 'decrement')] : []),
    ...now.flatMap((invitation) => retireInvitationItems(invitation, 'revoked')),
    ...(floorOrg ? [...floorOrg.items, auditPut(floorOrg.event)] : []),
  ];
  const failure = {
    orgId,
    targetUserId,
    wasOwner,
    revocations: now.length,
    floorOrg: floorOrg !== undefined,
  };

  const orgProfile = await getOrgProfile(orgId);
  const { keysToRevoke, fence } = await reviewKeysForRoleChange(orgId, targetUserId, NO_ROLE);
  const changedBy = actorEmail ?? userId;

  const committed = await commitAfterRevokingKeys({
    items,
    keys: keysToRevoke,
    fence,
    orgId,
    orgProfile,
    actor: userActor({ userId, email: actorEmail }),
    trigger: 'member_removed',
    auditEventType: 'member.removed',
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
  if ('keyMinted' in committed)
    return keyMintedResponse(targetEmail ?? 'that member', committed.keyMinted);

  return await finishRemoval({
    orgId,
    orgProfile,
    targetUserId,
    changedBy,
    later,
    revoked: committed.revoked,
  });
}

/** Either the member the removal names, or the response that refuses to name one. */
type RemovalGate =
  | { ok: true; target: OrgMembership }
  | { ok: false; refusal: APIGatewayProxyStructuredResultV2 };

/**
 * The path's `userId`, resolved into a member — or the refusal to stop at.
 *
 * Two different gates behind one route, decided here because the requirement
 * depends on whether the path names the caller:
 *
 * - **Removing someone else** costs `members.manage`, checked ahead of the
 *   path param itself so a caller who could never do this either way is
 *   refused the same permission error a malformed request from them always
 *   got, not a 400 that leaks whether the path happened to be well-formed.
 *   The ceiling on top of that (`owners.manage` to remove an Owner) is
 *   `requireManageableMember`'s.
 * - **Leaving** costs nothing beyond being a member — the chain's
 *   `requireOrgMembershipMiddleware()` already confirmed that, and the
 *   ceiling `requireManageableMember` enforces is about managing *someone
 *   else*, which does not apply to a member removing themselves.
 */
async function resolveRemovalTarget(
  event: AuthenticatedEvent,
  { orgId, userId, targetUserId }: { orgId: string; userId: string; targetUserId?: string },
): Promise<RemovalGate> {
  if (targetUserId !== userId) {
    const denied = requirePermission(event, 'members.manage');
    if (denied) return { ok: false, refusal: denied };
  }
  if (!targetUserId) return { ok: false, refusal: badRequestResponse('Missing userId in path') };

  if (targetUserId === userId) {
    const resolved = await resolveMembership(orgId, targetUserId);
    return resolved ? { ok: true, target: resolved } : { ok: false, refusal: notAMemberResponse() };
  }

  const gate = await requireManageableMember(event, { kind: 'removal' });
  return gate.ok ? { ok: true, target: gate.value } : { ok: false, refusal: gate.refusal };
}

/**
 * Every local precondition that can refuse the removal, checked before a key is
 * touched, since a revocation cannot be undone.
 *
 * The last-Owner guard is the decrement's own condition, so it is read here
 * rather than waited for, and a counter that cannot be read refuses on the same
 * ground: the decrement conditions on `ownerCount`, so a missing META row
 * cancels the transaction just the same and the removal would end with the
 * member still here and their credentials gone.
 */
async function refuseBeforeRevokingKeys(
  orgId: string,
  wasOwner: boolean,
): Promise<APIGatewayProxyStructuredResultV2 | undefined> {
  if (!wasOwner) return undefined;

  const owners = await readOwnerCount(orgId);
  if (owners === 1) return lastOwnerResponse(LAST_OWNER_REMEDY);
  if (owners === undefined) return refuseWithoutOwnerCount(orgId);
  return undefined;
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

  return new ResponseBuilder()
    .status(200)
    .body<RemoveMemberResponse>(
      // Named only when there are any, so removing somebody who held no key
      // answers with the empty body rather than an empty list.
      revoked.length > 0 ? { revokedKeys: revoked } : {},
    )
    .build();
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
 * The removed member's address as stored, or undefined when we do not hold one.
 *
 * Held because the two paths that learn a verified address write it: account
 * creation and invitation acceptance (`lib/user-profile.ts`). So undefined is
 * now the rare answer — a row written before either did, or a read that failed
 * — rather than the only one, and it is worth a log line each time. Without one
 * the sweep narrows to the invitations the member issued: the invitation their
 * old link belongs to stays live until it expires, and an operator reading this
 * line is the only person who can revoke it by hand.
 *
 * As stored rather than normalized, because it has two readers now: the sweep
 * matches on it and normalizes at the call site, and a fence refusal shows it
 * to an admin, who should see the address the roster showed them.
 */
function removedMemberAddress(userId: string, email: string | undefined): string | undefined {
  if (!email) {
    console.error(
      '[remove-member] No address for the removed member — invitations to them stay live',
      { userId },
    );
  }
  return email;
}

/** What a cancelled removal needs to tell one refusal from another. */
interface RemovalFailure {
  orgId: string;
  targetUserId: string;
  wasOwner: boolean;
  revocations: number;
  /** Whether a floor org was prepared alongside this removal. */
  floorOrg: boolean;
  /**
   * Keys the pass already revoked. They are gone whatever the membership now
   * says, so every refusal below carries them: a removal that cancels after a
   * revocation leaves a member in the org whose clients have stopped working,
   * and an answer that mentions only the membership hides that.
   */
  revokedKeys: AccessKeySummary[];
}

/**
 * A floor org for the removal to create alongside itself, or undefined when
 * the target keeps somewhere else to log in — or when it doesn't, but nothing
 * here can name the row that needs repointing.
 *
 * `listMemberships` is read fresh rather than reused from anywhere else: it is
 * the strongly-consistent count of every org this account belongs to right
 * now, and the removal about to happen is not among them yet, so a count of
 * one means this org is the only one — the removal would take it to zero.
 */
async function prepareFloorOrgIfLastMembership({
  targetUserId,
  orgId,
  name,
  email,
}: {
  targetUserId: string;
  orgId: string;
  name?: string;
  email?: string;
}): Promise<FloorOrgPreparation | undefined> {
  const memberships = await listMemberships(targetUserId);
  if (memberships.length > 1) return undefined;

  const sub = await readUserSub(targetUserId, { consistentRead: true });
  if (!sub) {
    console.error(
      '[remove-member] Removed member has no sub on their profile — leaving them without an org',
      { targetUserId, orgId },
    );
    return undefined;
  }

  return prepareFloorOrg({ userId: targetUserId, sub, leavingOrgId: orgId, name, email });
}

async function removalFailureResponse(
  err: unknown,
  { orgId, targetUserId, wasOwner, revocations, floorOrg, revokedKeys }: RemovalFailure,
): Promise<APIGatewayProxyStructuredResultV2> {
  // `prepareFloorOrg` returns seven items, plus the audit Put appended
  // alongside them above (eight total); every one of their conditions failing
  // means the same thing to the caller (try the removal again), so they share
  // one label rather than naming each row.
  const failed = cancelledLabels(err, [
    'membership',
    'inverse',
    ...(wasOwner ? ['ownerCount'] : []),
    ...Array.from({ length: revocations * 2 }, () => 'invitation'),
    ...(floorOrg ? Array.from({ length: 8 }, () => 'floorOrg') : []),
  ]);
  if (failed.length === 0) throw err;
  if (failed.includes('floorOrg')) return floorOrgRaceResponse();

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

/**
 * The floor org this removal prepared could not be created — most likely the
 * repoint's condition lost a race with something else that changed the
 * target's home org in the same window. Retrying re-reads the membership
 * count and prepares a fresh org, rather than resending stale items.
 */
function floorOrgRaceResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({
      message: 'That member’s account changed while this was in flight — try again.',
    })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  // Membership only at the gate — the handler decides whether this request
  // also needs `members.manage`, since a self-targeted one does not.
  .use(requireOrgMembershipMiddleware())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
