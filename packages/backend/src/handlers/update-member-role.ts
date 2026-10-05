import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateMemberRoleSchema, canManageTargetRole, roleNarrows } from '@filone/shared';
import type {
  OrgRole,
  AccessKeySummary,
  UpdateMemberRoleFailure,
  UpdateMemberRoleResponse,
} from '@filone/shared';
import { AuditSubjects, userActor } from '../lib/audit.ts';
import { commitAfterRevokingKeys } from '../lib/commit-after-revoking-keys.ts';
import { reviewKeysForRoleChange } from '../lib/member-keys.ts';
import { notifyRevokedKeys } from '../lib/key-revocation-email.ts';
import { pendingInvitationsFrom, planRevocations, revokeDeferred } from '../lib/invitations.ts';
import type { InvitationRecord } from '../lib/invitations.ts';
import { requireManageableMember } from '../lib/manageable-member.ts';
import {
  cancelledLabels,
  labelled,
  ownerCountDeltaFor,
  ownerCountItem,
  roleChangeItems,
  withInvitationRevocations,
} from '../lib/membership-changes.ts';
import type { LabelledItems } from '../lib/membership-changes.ts';
import { readOwnerCount, readOwnerCountForDiagnosis } from '../lib/org-membership.ts';
import { readUserProfile } from '../lib/user-profile.ts';
import type { UserProfile } from '../lib/user-profile.ts';
import {
  OrgDeletingError,
  getOrgProfile,
  isGuardRejection,
  orgNotDeletingCheck,
} from '../lib/org-profile.ts';
import type { OrgProfileItem } from '../lib/org-profile.ts';
import { parseJsonBody } from '../lib/parse-json-body.ts';
import {
  ResponseBuilder,
  invitationRaceResponse,
  keyMintedResponse,
  lastOwnerResponse,
  memberRoleChangedResponse,
  ownerCountUnavailableResponse,
  refusedKeysSubject,
  unattributableFailure,
} from '../lib/response-builder.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { authorize } from '../middleware/authorize.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';

const SOURCE = 'update-member-role';

/** The way out of a last-Owner refusal, for somebody demoting one. */
const LAST_OWNER_REMEDY = 'Promote another member to owner first.';

/**
 * The two profiles only a narrowing reads: the org's, so the revocation pass
 * knows which tenant holds each key, and the member's, so a fence refusal can
 * name whose key was minted.
 *
 * One call holding the condition rather than two entries in the caller's wave,
 * because they share it — a widening strands no key, so it reads neither and
 * answers with both absent.
 */
async function readProfilesForNarrowing(
  narrows: boolean,
  orgId: string,
  targetUserId: string,
): Promise<{ orgProfile?: OrgProfileItem; targetProfile?: UserProfile }> {
  if (!narrows) return {};

  const [orgProfile, targetProfile] = await Promise.all([
    getOrgProfile(orgId),
    readUserProfile(targetUserId),
  ]);
  return { orgProfile, targetProfile };
}

/**
 * PATCH /api/org/members/{userId} — move a member to another role.
 *
 * A role change is two reaches, at the member as they are and at the member as
 * they would be, so both clear the ceiling (`canChangeRole`): an Admin can
 * neither demote an Owner nor promote anyone to Owner, and either attempt is a
 * 403 rather than a partial change.
 *
 * One transaction carries all of it, behind the org-deletion fence as item 0:
 * both membership rows, the `ownerCount` delta when the owner set moves, the
 * pending invitations the member may no longer issue, and the audit event. The
 * fence is what stops the inverse item's deliberately unconditional update from
 * recreating a membership row a teardown has already walked past
 * (`lib/membership-changes.ts`). The last-Owner guard is the decrement's own
 * condition, which is why a PATCH cannot demote the last Owner — nothing here
 * checks for it, the counter does.
 *
 * Revoking invitations on the way down is the same rule the accept path's
 * `ConditionCheck` enforces, applied early: an invitation must not outlive its
 * issuer's authority. Only the ones the NEW role could not have issued are
 * revoked, so demoting an Owner to Admin retires their Owner invitations and
 * leaves the rest alone.
 *
 * The keys the new role could not mint go the same way, at the vendor and
 * before the role is written (`lib/commit-after-revoking-keys.ts`), and the
 * transaction asserts no key was minted since that listing
 * (`lib/access-key-mint-seq.ts`).
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId, userId } = getUserInfo(event);
  const actorEmail = getVerifiedEmail(event);

  const parsed = parseJsonBody(event.body, UpdateMemberRoleSchema);
  if ('error' in parsed) return parsed.error;
  const { role } = parsed.data;

  // After the body: the ceiling is asked about the role requested as well as
  // the one held.
  const gate = await requireManageableMember(event, { kind: 'role-change', toRole: role });
  if (!gate.ok) return gate.refusal;
  const target = gate.value;
  const targetUserId = target.userId;

  // The console submits the form whether or not the select changed, and an
  // event saying a member went from Admin to Admin is noise in a log a customer
  // reads.
  if (target.role === role) {
    return roleResponse({ userId: targetUserId, role, previousRole: role });
  }

  // A widening strands nothing: every key its holder could mint before, they
  // could mint after, so only a narrowing reads keys or the profile.
  const narrows = roleNarrows(target.role, role);
  const delta = ownerCountDeltaFor(target.role, role);

  // Independent, so one wave rather than three.
  const [pending, { orgProfile, targetProfile }, owners] = await Promise.all([
    pendingInvitationsFrom(orgId, targetUserId),
    readProfilesForNarrowing(narrows, orgId, targetUserId),
    delta === 'decrement' ? readOwnerCount(orgId) : undefined,
  ]);

  const refused = refuseBeforeRevokingKeys(orgId, delta, owners);
  if (refused) return refused;

  const invitationsToRevoke = pending.filter(
    (invitation) => !canManageTargetRole(role, invitation.role),
  );
  const base = roleChangeBase({ orgId, targetUserId, fromRole: target.role, toRole: role });
  const { now, later } = planRevocations(invitationsToRevoke, base.items.length);
  const change = withInvitationRevocations(base, now);

  const review = narrows
    ? await reviewKeysForRoleChange(orgId, targetUserId, role)
    : { keysToRevoke: [], fence: undefined };
  const changedBy = actorEmail ?? userId;
  const failure = { orgId, delta, labels: change.labels };

  const committed = await commitAfterRevokingKeys({
    items: change.items,
    keys: review.keysToRevoke,
    fence: review.fence,
    orgId,
    orgProfile,
    actor: userActor({ userId, email: actorEmail }),
    trigger: 'role_narrowing',
    auditEventType: 'member.role_changed',
    subject: AuditSubjects.user(targetUserId),
    details: {
      role,
      previousRole: target.role,
      ...(invitationsToRevoke.length > 0 ? { revokedInvitations: invitationsToRevoke.length } : {}),
    },
    source: SOURCE,
    onCancelled: (err, revokedKeys) => changeFailureResponse(err, { ...failure, revokedKeys }),
    onRefused: (refused, revoked) => vendorRefusedResponse(revoked, refused),
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
  // Named by address: an admin told a key was created "for that member" cannot
  // tell which of their members to go and look at.
  if ('keyMinted' in committed)
    return keyMintedResponse(targetProfile?.email ?? 'that member', committed.keyMinted);

  return await finishRoleChange({
    orgId,
    orgProfile,
    targetUserId,
    fromRole: target.role,
    toRole: role,
    changedBy,
    later,
    revoked: committed.revoked,
  });
}

/**
 * The tail once the role is written: the invitations that did not fit the
 * transaction, the member's email, and the answer.
 *
 * Nothing here can fail the request. The role is where the caller wanted it,
 * and an error now would send them into a retry that finds it there and answers
 * as a no-op, while the thing that failed was a notification.
 */
async function finishRoleChange({
  orgId,
  orgProfile,
  targetUserId,
  fromRole,
  toRole,
  changedBy,
  later,
  revoked,
}: {
  orgId: string;
  orgProfile: OrgProfileItem | undefined;
  targetUserId: string;
  fromRole: OrgRole;
  toRole: OrgRole;
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
    cause: { kind: 'role_changed', previousRole: fromRole, role: toRole },
    source: SOURCE,
  });

  return roleResponse({
    userId: targetUserId,
    role: toRole,
    previousRole: fromRole,
    // Named only when there are any, so a widening and a no-op read alike.
    ...(revoked.length > 0 ? { revokedKeys: revoked } : {}),
  });
}

/**
 * Every local precondition that can refuse this change, checked before a key is
 * touched, since a revocation cannot be undone.
 *
 * The last-Owner guard is the decrement's own condition, so the count is read
 * ahead rather than waited for: a sole Owner demoting themselves must be
 * refused with their keys intact. A counter that cannot be read refuses too,
 * because the decrement conditions on `ownerCount` and a missing META row
 * cancels the transaction just the same — with the role unchanged and the keys
 * gone.
 */
function refuseBeforeRevokingKeys(
  orgId: string,
  delta: ReturnType<typeof ownerCountDeltaFor>,
  owners: number | undefined,
): APIGatewayProxyStructuredResultV2 | undefined {
  if (delta !== 'decrement') return undefined;

  if (owners === 1) return lastOwnerResponse(LAST_OWNER_REMEDY);
  if (owners === undefined) {
    console.error('[update-member-role] ownerCount missing — role change refused', { orgId });
    return ownerCountUnavailableResponse('updated');
  }
  return undefined;
}

/** The fence, both membership rows, and the counter when the owner set moves. */
function roleChangeBase({
  orgId,
  targetUserId,
  fromRole,
  toRole,
}: {
  orgId: string;
  targetUserId: string;
  fromRole: OrgRole;
  toRole: OrgRole;
}): LabelledItems {
  const delta = ownerCountDeltaFor(fromRole, toRole);
  const [membership, inverse] = roleChangeItems({ orgId, userId: targetUserId, fromRole, toRole });

  return labelled([
    ['org', orgNotDeletingCheck(orgId)],
    ['membership', membership],
    ['inverse', inverse],
    ...(delta === 'unchanged' ? [] : [['ownerCount', ownerCountItem(orgId, delta)] as const]),
  ]);
}

/** The answer when the role transaction cancels; every answer carries `revokedKeys`. */
async function changeFailureResponse(
  err: unknown,
  context: {
    orgId: string;
    delta: ReturnType<typeof ownerCountDeltaFor>;
    labels: string[];
    revokedKeys: AccessKeySummary[];
  },
): Promise<APIGatewayProxyStructuredResultV2> {
  // The fence, at its own index. A role change into an org being torn down has
  // no remedy, so it leaves through the shared error rather than a 409.
  if (isGuardRejection(err)) throw new OrgDeletingError(context.orgId);

  const failed = cancelledLabels(err, context.labels);
  if (failed.length === 0) {
    return unattributableFailure(err, {
      source: SOURCE,
      orgId: context.orgId,
      revokedKeys: context.revokedKeys,
    });
  }

  const { revokedKeys } = context;

  if (failed.includes('ownerCount')) {
    // The decrement's condition IS the last-Owner invariant: an org at one Owner
    // cancels the transaction that would take it to zero. It reads `ownerCount`
    // though, so a missing counter cancels the same update for the opposite
    // reason — the guard was never armed — and saying "you are the last Owner"
    // about an org whose counter we cannot read would be a guess. A read that
    // fails is the same guess, and it must not cost the answer the revoked keys.
    if (
      context.delta === 'decrement' &&
      (await readOwnerCountForDiagnosis(context.orgId)) !== undefined
    ) {
      return lastOwnerResponse(LAST_OWNER_REMEDY, revokedKeys);
    }
    console.error('[update-member-role] ownerCount unreadable — role change refused', {
      orgId: context.orgId,
    });
    return ownerCountUnavailableResponse('updated', revokedKeys);
  }
  if (failed.includes('invitation')) return invitationRaceResponse(revokedKeys);
  return memberRoleChangedResponse('while you were editing it', revokedKeys);
}

function roleResponse(body: UpdateMemberRoleResponse): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder().status(200).body<UpdateMemberRoleResponse>(body).build();
}

/**
 * A vendor refused a revocation, so the role is unchanged and the keys already
 * revoked are named. Retrying is the same PATCH, which finds fewer keys.
 */
function vendorRefusedResponse(
  revokedKeys: AccessKeySummary[],
  failedKeys: AccessKeySummary[],
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(502)
    .body<UpdateMemberRoleFailure>({
      message: `${refusedKeysSubject(failedKeys)} could not be revoked, so the role is unchanged. Try again.`,
      revokedKeys,
      failedKeys,
    })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('members.manage'))
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
