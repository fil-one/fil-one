import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import {
  ApiErrorCode,
  UpdateMemberRoleSchema,
  canChangeRole,
  canManageTargetRole,
  roleNarrows,
} from '@filone/shared';
import type {
  ErrorResponse,
  OrgRole,
  RevokedKeySummary,
  UpdateMemberRoleFailure,
  UpdateMemberRoleResponse,
} from '@filone/shared';
import {
  AuditSubjects,
  auditEvent,
  commitAudited,
  twoPhaseAudit,
  userActor,
} from '../lib/audit.js';
import { keysExceedingRole } from '../lib/member-keys.js';
import { sendKeyRevocationEmail } from '../lib/key-revocation-email.js';
import { revokeMemberKeys } from '../lib/revoke-member-keys.js';
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
import { readOwnerCount, resolveMembership } from '../lib/org-membership.js';
import {
  OrgDeletingError,
  getOrgProfile,
  isGuardRejection,
  orgNotDeletingCheck,
} from '../lib/org-profile.js';
import { parseJsonBody } from '../lib/parse-json-body.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuditActor } from '@filone/shared';
import type { OrgProfileItem } from '../lib/org-profile.js';
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
  // The fence and both membership rows, plus the counter when the owner set
  // moves.
  const { now, later } = planRevocations(doomed, delta === 'unchanged' ? 3 : 4);

  // Every local precondition that can refuse this change is checked before a
  // key is touched, since a revocation cannot be undone. The last-Owner guard
  // is the decrement's own condition, so it is read here rather than waited
  // for: a sole Owner demoting themselves must be refused with their keys
  // intact.
  if (delta === 'decrement' && (await readOwnerCount(orgId)) === 1) return lastOwnerResponse();

  return await applyRoleChange({
    orgId,
    targetUserId,
    fromRole: target.role,
    toRole: role,
    actor: userActor({ userId, email: actorEmail }),
    changedBy: actorEmail ?? userId,
    invitations: { now, later },
    revokedInvitations: doomed.length,
    delta,
  });
}

/**
 * Revoke, write the role, revoke again, and say what happened.
 *
 * The order is the whole of it. An access key carries its own permission set,
 * fixed when it was minted, and nothing at Aurora or FTH evaluates it against
 * the role its holder now has. So the keys the new role could not mint are
 * revoked at the vendor BEFORE the role is written: a member is never wider at
 * a storage vendor than the role the console records for them.
 *
 * The second pass exists because the first reads a list. A key minted by a
 * request that read the old role can land between the listing and the role
 * write; the mint path's own `ConditionCheck` (`create-access-key.ts`) refuses
 * a row written after the role changed, and this pass catches one written just
 * before it. Neither guard covers the other's window.
 */
interface RoleChange {
  orgId: string;
  targetUserId: string;
  fromRole: OrgRole;
  toRole: OrgRole;
  actor: AuditActor;
  /** The admin, by verified email or by id, for the member's email. */
  changedBy: string;
  /** The target's pending invitations the new role could not have issued. */
  invitations: { now: InvitationRecord[]; later: InvitationRecord[] };
  revokedInvitations: number;
  delta: ReturnType<typeof ownerCountDeltaFor>;
}

async function applyRoleChange({
  orgId,
  targetUserId,
  fromRole,
  toRole,
  actor,
  changedBy,
  invitations,
  revokedInvitations,
  delta,
}: RoleChange): Promise<APIGatewayProxyStructuredResultV2> {
  const details = {
    role: toRole,
    previousRole: fromRole,
    ...(revokedInvitations > 0 ? { revokedInvitations } : {}),
  };
  const write = (
    event: Parameters<typeof commitAudited>[0]['event'],
    revokedKeys: RevokedKeySummary[],
  ) =>
    writeRole({
      items: changeItems({ orgId, targetUserId, fromRole, toRole, now: invitations.now }),
      event,
      failure: { orgId, delta, revocations: invitations.now.length, revokedKeys },
    });
  const singlePhase = () =>
    auditEvent({
      type: 'member.role_changed',
      actor,
      orgId,
      subject: AuditSubjects.user(targetUserId),
      details,
    });

  // A widening strands nothing: every key its holder could mint before, they
  // could mint after. Only a narrowing has to look at what they already hold.
  const narrows = roleNarrows(fromRole, toRole);
  const orgProfile = narrows ? await getOrgProfile(orgId) : undefined;
  const review = narrows
    ? await keysExceedingRole(orgId, targetUserId, toRole)
    : { doomed: [], survivingCount: 0, unattributedCount: 0 };
  const secondPass = (alreadyRevoked: RevokedKeySummary[]) =>
    runSecondPass({
      orgId,
      orgProfile,
      targetUserId,
      fromRole,
      toRole,
      actor,
      changedBy,
      alreadyRevoked,
    });

  // A change that revokes no key touches no vendor, so it stays one transaction
  // and one event, the form every membership change took in M1.
  if (review.doomed.length === 0) {
    const failed = await write(singlePhase(), []);
    if (failed) return failed;
    await revokeDeferred(invitations.later);
    if (!narrows) {
      return roleResponse({ userId: targetUserId, role: toRole, previousRole: fromRole });
    }
    return await secondPass([]);
  }

  const change = await twoPhaseAudit({
    type: 'member.role_changed',
    mode: 'fail-closed',
    actor,
    orgId,
    subject: AuditSubjects.user(targetUserId),
    details,
  });

  const first = await revokeMemberKeys({
    orgId,
    orgProfile,
    keys: review.doomed,
    actor,
    reason: 'role_narrowing',
  });
  if (first.failed) {
    await change.complete({ outcome: 'failed', details: revokedKeyIds(first.revoked) });
    return vendorRefusedResponse(first.revoked, first.failed.key);
  }

  const failed = await write(
    auditEvent({
      type: 'member.role_changed',
      actor,
      orgId,
      subject: AuditSubjects.user(targetUserId),
      details: { ...details, ...revokedKeyIds(first.revoked) },
      phase: 'completion',
      correlationId: change.correlationId,
      outcome: 'succeeded',
    }),
    first.revoked,
  );
  if (failed) return failed;

  await revokeDeferred(invitations.later);
  return await secondPass(first.revoked);
}

/**
 * The role transaction, and the answer when it cancels.
 *
 * Returns undefined when the role is written. Anything else is the response:
 * the keys named in `revokedKeys` are already gone whatever the role now says,
 * so the caller reports them rather than treating the request as a no-op.
 */
async function writeRole({
  items,
  event,
  failure,
}: {
  items: TransactWriteItem[];
  event: Parameters<typeof commitAudited>[0]['event'];
  failure: {
    orgId: string;
    delta: ReturnType<typeof ownerCountDeltaFor>;
    revocations: number;
    revokedKeys: RevokedKeySummary[];
  };
}): Promise<APIGatewayProxyStructuredResultV2 | undefined> {
  try {
    await commitAudited({ items, event });
    return undefined;
  } catch (err) {
    if (failure.revokedKeys.length > 0) {
      // The keys are gone and the role is not written. The retry is the same
      // PATCH, which finds fewer keys: every completed revocation deleted its
      // row.
      console.error('[update-member-role] Role write failed after revoking keys', {
        orgId: failure.orgId,
        revoked: failure.revokedKeys.length,
      });
    }
    return await changeFailureResponse(err, failure);
  }
}

/**
 * The pass after the role is written.
 *
 * The first pass reads a list, and a key minted by a request that read the old
 * role can land between that listing and the role write. The mint path's own
 * `ConditionCheck` (`create-access-key.ts`) refuses a row written after the
 * role changed; this catches one written just before it. Neither guard covers
 * the other's window.
 */
async function runSecondPass({
  orgId,
  orgProfile,
  targetUserId,
  fromRole,
  toRole,
  actor,
  changedBy,
  alreadyRevoked,
}: {
  orgId: string;
  orgProfile: OrgProfileItem | undefined;
  targetUserId: string;
  fromRole: OrgRole;
  toRole: OrgRole;
  actor: AuditActor;
  changedBy: string;
  alreadyRevoked: RevokedKeySummary[];
}): Promise<APIGatewayProxyStructuredResultV2> {
  // Skipping what the first pass took: its row delete rides the revocation's
  // audit completion, and a completion that could not be written leaves the row
  // listed for a credential that is already gone.
  const alreadyGone = new Set(alreadyRevoked.map((key) => key.id));
  const second = await revokeMemberKeys({
    orgId,
    orgProfile,
    keys: (await keysExceedingRole(orgId, targetUserId, toRole)).doomed.filter(
      (key) => !alreadyGone.has(key.id),
    ),
    actor,
    reason: 'role_narrowing',
  });

  const revokedKeys = [...alreadyRevoked, ...second.revoked];
  await sendKeyRevocationEmail({
    userId: targetUserId,
    orgName: orgProfile?.name?.S ?? 'your organization',
    keys: revokedKeys,
    previousRole: fromRole,
    role: toRole,
    changedBy,
  });

  return roleResponse({
    userId: targetUserId,
    role: toRole,
    previousRole: fromRole,
    ...(revokedKeys.length > 0 ? { revokedKeys } : {}),
  });
}

/** The summary half of the pair: ids, since each revocation is its own event. */
function revokedKeyIds(revoked: readonly RevokedKeySummary[]): { revokedKeys?: string[] } {
  return revoked.length > 0 ? { revokedKeys: revoked.map((key) => key.id) } : {};
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
    orgNotDeletingCheck(orgId),
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
    'org',
    'membership',
    'inverse',
    ...(delta === 'unchanged' ? [] : ['ownerCount']),
    ...Array.from({ length: revocations * 2 }, () => 'invitation'),
  ];
}

async function changeFailureResponse(
  err: unknown,
  context: {
    orgId: string;
    delta: ReturnType<typeof ownerCountDeltaFor>;
    revocations: number;
    /** Already revoked and not coming back, whatever the role write did. */
    revokedKeys: RevokedKeySummary[];
  },
): Promise<APIGatewayProxyStructuredResultV2> {
  // The fence, at its own index. A role change into an org being torn down has
  // no remedy, so it leaves through the shared error rather than a 409.
  if (isGuardRejection(err)) throw new OrgDeletingError(context.orgId);

  const failed = cancelledLabels(err, changeLabels(context));
  if (failed.length === 0) throw err;

  const revoked = { revokedKeys: context.revokedKeys };

  if (failed.includes('ownerCount')) {
    // The decrement's condition IS the last-Owner invariant: an org at one Owner
    // cancels the transaction that would take it to zero. It reads `ownerCount`
    // though, so a missing counter cancels the same update for the opposite
    // reason — the guard was never armed — and saying "you are the last Owner"
    // about an org whose counter we cannot read would be a guess.
    if (context.delta === 'decrement' && (await readOwnerCount(context.orgId)) !== undefined) {
      return lastOwnerResponse(revoked);
    }
    console.error('[update-member-role] ownerCount missing — role change refused', {
      orgId: context.orgId,
    });
    return ownerCountUnavailableResponse(revoked);
  }
  if (failed.includes('invitation')) return invitationRaceResponse(revoked);
  return concurrentChangeResponse(revoked);
}

function roleResponse(body: UpdateMemberRoleResponse): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder().status(200).body<UpdateMemberRoleResponse>(body).build();
}

/**
 * A vendor refused a revocation, so the role is unchanged and the keys already
 * revoked are named. Retrying is the same PATCH, which finds fewer keys.
 */
function vendorRefusedResponse(
  revokedKeys: RevokedKeySummary[],
  failedKey: RevokedKeySummary,
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(502)
    .body<UpdateMemberRoleFailure>({
      message: `The key "${failedKey.keyName}" could not be revoked, so the role is unchanged. Try again.`,
      revokedKeys,
      failedKey,
    })
    .build();
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

function lastOwnerResponse(
  revoked: { revokedKeys: RevokedKeySummary[] } = { revokedKeys: [] },
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse & { revokedKeys: RevokedKeySummary[] }>({
      message:
        'This organization would be left without an owner. Promote another member to owner first.',
      code: ApiErrorCode.LAST_OWNER,
      ...revoked,
    })
    .build();
}

function ownerCountUnavailableResponse(
  revoked: { revokedKeys: RevokedKeySummary[] } = { revokedKeys: [] },
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse & { revokedKeys: RevokedKeySummary[] }>({
      message: 'The organization’s owner count could not be updated. Please contact support.',
      ...revoked,
    })
    .build();
}

function invitationRaceResponse(
  revoked: { revokedKeys: RevokedKeySummary[] } = { revokedKeys: [] },
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse & { revokedKeys: RevokedKeySummary[] }>({
      message: 'An invitation from that member changed while this was in flight — try again.',
      ...revoked,
    })
    .build();
}

function concurrentChangeResponse(
  revoked: { revokedKeys: RevokedKeySummary[] } = { revokedKeys: [] },
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse & { revokedKeys: RevokedKeySummary[] }>({
      message: 'That member’s role changed while you were editing it.',
      ...revoked,
    })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('members.manage'))
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
