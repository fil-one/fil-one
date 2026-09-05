import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import {
  ApiErrorCode,
  UpdateMemberRoleSchema,
  canManageTargetRole,
  roleNarrows,
} from '@filone/shared';
import type {
  OrgRole,
  AccessKeySummary,
  UpdateMemberRoleFailure,
  UpdateMemberRoleResponse,
} from '@filone/shared';
import { AuditSubjects, userActor } from '../lib/audit.js';
import { commitAfterRevokingKeys } from '../lib/commit-after-revoking-keys.js';
import { reviewMemberAccessKeysForRole } from '../lib/member-keys.js';
import type { AccessKeyToRevoke } from '../lib/member-keys.js';
import { notifyRevokedKeys } from '../lib/key-revocation-email.js';
import {
  pendingInvitationsFrom,
  planRevocations,
  retireInvitationItems,
  revokeDeferred,
} from '../lib/invitations.js';
import type { InvitationRecord } from '../lib/invitations.js';
import { requireManageableMember } from '../lib/manageable-member.js';
import {
  cancelledLabels,
  ownerCountDeltaFor,
  ownerCountItem,
  roleChangeItems,
} from '../lib/membership-changes.js';
import { readOwnerCount } from '../lib/org-membership.js';
import {
  OrgDeletingError,
  getOrgProfile,
  isGuardRejection,
  orgNotDeletingCheck,
} from '../lib/org-profile.js';
import type { OrgProfileItem } from '../lib/org-profile.js';
import { parseJsonBody } from '../lib/parse-json-body.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { ErrorWithRevokedKeys } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

const SOURCE = 'update-member-role';

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
 * before the role is written (`lib/commit-after-revoking-keys.ts`).
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

  const invitationsToRevoke = (await pendingInvitationsFrom(orgId, targetUserId)).filter(
    (invitation) => !canManageTargetRole(role, invitation.role),
  );
  const delta = ownerCountDeltaFor(target.role, role);
  const base = roleChangeBase({ orgId, targetUserId, fromRole: target.role, toRole: role });
  const { now, later } = planRevocations(invitationsToRevoke, base.items.length);
  const change = withInvitationRevocations(base, now);

  const refused = await refuseBeforeRevokingKeys(orgId, delta);
  if (refused) return refused;

  const { orgProfile, keysToRevoke } = await reviewAccessKeysForNarrowing(
    orgId,
    targetUserId,
    target.role,
    role,
  );
  const changedBy = actorEmail ?? userId;
  const failure = { orgId, delta, labels: change.labels };

  const committed = await commitAfterRevokingKeys({
    items: change.items,
    keys: keysToRevoke,
    orgId,
    orgProfile,
    actor: userActor({ userId, email: actorEmail }),
    trigger: 'role_narrowing',
    type: 'member.role_changed',
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
 * Every local precondition that can refuse this change is checked before a key
 * is touched, since a revocation cannot be undone. The last-Owner guard is the
 * decrement's own condition, so it is read here rather than waited for: a sole
 * Owner demoting themselves must be refused with their keys intact. A counter
 * that cannot be read refuses too. The decrement conditions on `ownerCount`, so
 * a missing META row cancels the transaction just the same, and the change
 * would end with the role unchanged and the keys gone.
 */
async function refuseBeforeRevokingKeys(
  orgId: string,
  delta: ReturnType<typeof ownerCountDeltaFor>,
): Promise<APIGatewayProxyStructuredResultV2 | undefined> {
  if (delta !== 'decrement') return undefined;

  const owners = await readOwnerCount(orgId);
  if (owners === 1) return lastOwnerResponse();
  if (owners === undefined) {
    console.error('[update-member-role] ownerCount missing — role change refused', { orgId });
    return ownerCountUnavailableResponse();
  }
  return undefined;
}

/**
 * The keys the new role could not mint, and the profile row their revocation
 * resolves tenants from. A widening strands nothing: every key its holder could
 * mint before, they could mint after. Only a narrowing has to look at what they
 * already hold, so a promotion reads neither.
 */
async function reviewAccessKeysForNarrowing(
  orgId: string,
  targetUserId: string,
  fromRole: OrgRole,
  toRole: OrgRole,
): Promise<{ orgProfile: OrgProfileItem | undefined; keysToRevoke: AccessKeyToRevoke[] }> {
  if (!roleNarrows(fromRole, toRole)) return { orgProfile: undefined, keysToRevoke: [] };

  const orgProfile = await getOrgProfile(orgId);
  const review = await reviewMemberAccessKeysForRole(orgId, targetUserId, toRole);
  return { orgProfile, keysToRevoke: review.keysToRevoke };
}

/**
 * The transaction's items with a label per position, so a cancellation names
 * what failed rather than an index.
 *
 * Built together rather than as two lists kept in step by hand: DynamoDB
 * reports cancellations positionally, so a label list one item out of line
 * would answer a genuine last-Owner refusal with "an invitation changed". An
 * item and its label are added or omitted in the same expression, and the item
 * count is read off the list rather than counted.
 */
interface LabelledItems {
  items: TransactWriteItem[];
  labels: string[];
}

function labelled(
  entries: ReadonlyArray<readonly [label: string, item: TransactWriteItem]>,
): LabelledItems {
  return {
    items: entries.map(([, item]) => item),
    labels: entries.map(([label]) => label),
  };
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

/** The base plus the invitations that fit beside it, two items each. */
function withInvitationRevocations(base: LabelledItems, now: InvitationRecord[]): LabelledItems {
  const items = now.flatMap((invitation) => retireInvitationItems(invitation, 'revoked'));
  return {
    items: [...base.items, ...items],
    labels: [...base.labels, ...items.map(() => 'invitation')],
  };
}

/**
 * The answer when the role transaction cancels. The keys named in `revokedKeys`
 * are already gone whatever the role now says, so every answer carries them
 * rather than treating the request as a no-op.
 */
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
  revokedKeys: AccessKeySummary[],
  failedKeys: AccessKeySummary[],
): APIGatewayProxyStructuredResultV2 {
  const named = failedKeys.map((key) => `"${key.keyName}"`).join(', ');
  const subject =
    failedKeys.length === 1 ? `The key ${named}` : `${failedKeys.length} keys (${named})`;

  return new ResponseBuilder()
    .status(502)
    .body<UpdateMemberRoleFailure>({
      message: `${subject} could not be revoked, so the role is unchanged. Try again.`,
      revokedKeys,
      failedKeys,
    })
    .build();
}

function lastOwnerResponse(
  revoked: { revokedKeys: AccessKeySummary[] } = { revokedKeys: [] },
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorWithRevokedKeys>({
      message:
        'This organization would be left without an owner. Promote another member to owner first.',
      code: ApiErrorCode.LAST_OWNER,
      ...revoked,
    })
    .build();
}

function ownerCountUnavailableResponse(
  revoked: { revokedKeys: AccessKeySummary[] } = { revokedKeys: [] },
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorWithRevokedKeys>({
      message: 'The organization’s owner count could not be updated. Please contact support.',
      ...revoked,
    })
    .build();
}

function invitationRaceResponse(
  revoked: { revokedKeys: AccessKeySummary[] } = { revokedKeys: [] },
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorWithRevokedKeys>({
      message: 'An invitation from that member changed while this was in flight — try again.',
      ...revoked,
    })
    .build();
}

function concurrentChangeResponse(
  revoked: { revokedKeys: AccessKeySummary[] } = { revokedKeys: [] },
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorWithRevokedKeys>({
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
