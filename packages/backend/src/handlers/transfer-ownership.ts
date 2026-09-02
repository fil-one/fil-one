import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { OrgRole, TransferOwnershipSchema, canManageTargetRole } from '@filone/shared';
import type {
  AuditActor,
  ErrorResponse,
  RevokedKeySummary,
  TransferOwnershipResponse,
} from '@filone/shared';
import {
  AuditSubjects,
  auditEvent,
  commitAudited,
  twoPhaseAudit,
  userActor,
} from '../lib/audit.js';
import { sendKeyRevocationEmail } from '../lib/key-revocation-email.js';
import { keysExceedingRole } from '../lib/member-keys.js';
import { bestEffort, revokeMemberKeys } from '../lib/revoke-member-keys.js';
import {
  pendingInvitationsFrom,
  planRevocations,
  retireInvitationItems,
  revokeDeferred,
} from '../lib/invitations.js';
import { cancelledLabels, ownerCountItem, roleChangeItems } from '../lib/membership-changes.js';
import { readOwnerCount, resolveMembership } from '../lib/org-membership.js';
import {
  OrgDeletingError,
  getOrgProfile,
  isGuardRejection,
  orgNotDeletingCheck,
} from '../lib/org-profile.js';
import type { OrgProfileItem } from '../lib/org-profile.js';
import type { DoomedKey } from '../lib/member-keys.js';
import { parseJsonBody } from '../lib/parse-json-body.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import { requireMfaIfEnrolled } from '../middleware/require-mfa.js';

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

  // `authorize('org.transfer')` is Owner-only, so this is the caller's role.
  const callerRole = membership!.role;

  // The same sweep a demotion runs, for the same reason: the outgoing Owner
  // becomes an Admin, and an Admin cannot issue an Owner invitation, so they
  // cannot keep one outstanding either. The accept path's ConditionCheck already
  // refuses those links, which makes this hygiene rather than a guard — no dead
  // links in inboxes, no slots held under the cap, no pending rows on the page
  // that nobody can explain.
  const doomed = (await pendingInvitationsFrom(orgId, userId)).filter(
    (invitation) => !canManageTargetRole(OrgRole.Admin, invitation.role),
  );
  const { now, later } = planRevocations(doomed, TRANSFER_ITEMS);

  const actor = userActor({ userId, email: actorEmail });
  const details = {
    fromUserId: userId,
    toUserId: targetUserId,
    ...(doomed.length > 0 ? { revokedInvitations: doomed.length } : {}),
  };
  const items = () => [
    orgNotDeletingCheck(orgId),
    ...roleChangeItems({
      orgId,
      userId: targetUserId,
      fromRole: target.role,
      toRole: OrgRole.Owner,
    }),
    ...roleChangeItems({
      orgId,
      userId,
      fromRole: callerRole,
      // The outgoing Owner stays, as an Admin: transferring the seat is not
      // leaving the org, and an org that loses its only administrator because
      // somebody handed over ownership is a support ticket.
      toRole: OrgRole.Admin,
    }),
    ownerCountItem(orgId, 'unchanged'),
    ...now.flatMap((invitation) => retireInvitationItems(invitation, 'revoked')),
  ];

  // Transfer is the role change the outgoing Owner undergoes, so it runs the
  // same pass a demotion does: an Admin cannot hold a key carrying
  // `PutObjectRetention` or `PutObjectLegalHold`, and one they already hold
  // would outlive the authority that minted it.
  // The transaction bumps `ownerCount` even though the owner set does not move,
  // and that update conditions on the attribute existing. A counter that cannot
  // be read therefore cancels the transfer, so it is refused here rather than
  // after the outgoing Owner's keys are already gone.
  if ((await readOwnerCount(orgId)) === undefined) return ownerCountUnavailableResponse(orgId);

  const orgProfile = await getOrgProfile(orgId);
  const review = await keysExceedingRole(orgId, userId, OrgRole.Admin);

  const handover = await moveTheSeat({
    orgId,
    orgProfile,
    actor,
    details,
    items: items(),
    doomed: review.doomed,
    revocations: now.length,
  });
  if ('response' in handover) return handover.response;

  await revokeDeferred(later);
  await finishTransfer({
    orgId,
    orgProfile,
    userId,
    actorEmail,
    revoked: handover.revoked,
  });

  return transferredResponse(targetUserId, userId);
}

/**
 * Revoke what the outgoing Owner could no longer mint, then move the seat.
 *
 * The revocation happens at the vendor before the roles are written, so the
 * outgoing Owner is never wider at a storage vendor than the Admin role the
 * console records for them. When it revokes nothing the whole transfer stays
 * one transaction and one event, which is every transfer by an Owner whose keys
 * an Admin could hold.
 */
async function moveTheSeat({
  orgId,
  orgProfile,
  actor,
  details,
  items,
  doomed,
  revocations,
}: {
  orgId: string;
  orgProfile: OrgProfileItem | undefined;
  actor: AuditActor;
  details: { fromUserId: string; toUserId: string; revokedInvitations?: number };
  items: TransactWriteItem[];
  doomed: readonly DoomedKey[];
  revocations: number;
}): Promise<{ revoked: RevokedKeySummary[] } | { response: APIGatewayProxyStructuredResultV2 }> {
  if (doomed.length === 0) {
    try {
      await commitAudited({
        items,
        event: auditEvent({
          type: 'ownership.transferred',
          actor,
          orgId,
          subject: AuditSubjects.org(orgId),
          details,
        }),
      });
    } catch (err) {
      return { response: transferFailureResponse(err, orgId, revocations) };
    }
    return { revoked: [] };
  }

  const handover = await twoPhaseAudit({
    type: 'ownership.transferred',
    mode: 'fail-closed',
    actor,
    orgId,
    subject: AuditSubjects.org(orgId),
    details,
  });

  const first = await revokeMemberKeys({
    orgId,
    orgProfile,
    keys: doomed,
    actor,
    reason: 'role_narrowing',
  });
  const revokedKeys = first.revoked.map((key) => key.id);
  if (first.failed.length > 0) {
    await handover.complete({
      outcome: 'failed',
      ...(revokedKeys.length > 0 ? { details: { revokedKeys } } : {}),
    });
    // The seat has not moved, but the keys this pass did revoke are gone and
    // the caller is the person who held them.
    return { response: vendorRefusedResponse(first.failed[0]!.keyName, first.revoked) };
  }

  try {
    await commitAudited({
      items,
      event: auditEvent({
        type: 'ownership.transferred',
        actor,
        orgId,
        subject: AuditSubjects.org(orgId),
        details: { ...details, ...(revokedKeys.length > 0 ? { revokedKeys } : {}) },
        phase: 'completion',
        correlationId: handover.correlationId,
        outcome: 'succeeded',
      }),
    });
  } catch (err) {
    console.error('[transfer-ownership] Transfer failed after revoking keys', {
      orgId,
      revoked: revokedKeys.length,
    });
    // Those credentials are gone whatever the seat now says, and the caller is
    // the person who held them, so the refusal has to carry them.
    return { response: transferFailureResponse(err, orgId, revocations, first.revoked) };
  }

  return { revoked: first.revoked };
}

/** The mail telling the outgoing Owner which of their keys stopped working. */
async function finishTransfer({
  orgId,
  orgProfile,
  userId,
  actorEmail,
  revoked,
}: {
  orgId: string;
  orgProfile: OrgProfileItem | undefined;
  userId: string;
  actorEmail: string | undefined;
  revoked: readonly RevokedKeySummary[];
}): Promise<void> {
  // The seat has moved by now, so this may not fail the request: the caller
  // would see an error for a transfer that happened, and the retry answers
  // already-owner.
  //
  // To themselves: the caller is the one whose keys went, and the console has
  // already answered them. Sent anyway, because a client that stops working
  // between deploys is worth a durable record in an inbox.
  await bestEffort(
    () =>
      sendKeyRevocationEmail({
        userId,
        orgName: orgProfile?.name?.S ?? 'your organization',
        keys: revoked,
        cause: { kind: 'role_changed', previousRole: OrgRole.Owner, role: OrgRole.Admin },
        changedBy: actorEmail ?? userId,
      }),
    undefined,
    { source: 'transfer-ownership', orgId },
  );
}

function transferredResponse(
  targetUserId: string,
  userId: string,
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(200)
    .body<TransferOwnershipResponse>({ userId: targetUserId, previousOwnerUserId: userId })
    .build();
}

/**
 * A vendor refused a revocation, so the seat has not moved and the keys already
 * revoked stay revoked. Retrying is the same POST, which finds fewer keys.
 */
function vendorRefusedResponse(
  keyName: string,
  revokedKeys: RevokedKeySummary[],
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(502)
    .body<ErrorResponse & { revokedKeys: RevokedKeySummary[] }>({
      message: `The key "${keyName}" could not be revoked, so ownership has not moved. Try again.`,
      revokedKeys,
    })
    .build();
}

/**
 * The fence, both role changes and the counter — what the sweep's revocations
 * sit behind.
 */
const TRANSFER_ITEMS = 6;

function transferFailureResponse(
  err: unknown,
  orgId: string,
  revocations: number,
  revokedKeys: RevokedKeySummary[] = [],
): APIGatewayProxyStructuredResultV2 {
  // The fence, at its own index: the org is being torn down and no retry helps.
  if (isGuardRejection(err)) throw new OrgDeletingError(orgId);

  const failed = cancelledLabels(err, [
    'org',
    'promotion',
    'promotionInverse',
    'demotion',
    'demotionInverse',
    'ownerCount',
    ...Array.from({ length: revocations * 2 }, () => 'invitation'),
  ]);
  if (failed.length === 0) throw err;

  console.warn('[transfer-ownership] Transfer cancelled', { failed });
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse & { revokedKeys: RevokedKeySummary[] }>({
      message: 'The organization’s roles changed while the transfer was in flight — try again.',
      revokedKeys,
    })
    .build();
}

/**
 * The counter cannot be read, so the transaction that bumps it would cancel.
 * Refused before anything is revoked, and the remedy is support rather than a
 * retry: the org's META row needs repairing.
 */
function ownerCountUnavailableResponse(orgId: string): APIGatewayProxyStructuredResultV2 {
  console.error('[transfer-ownership] ownerCount missing — transfer refused', { orgId });
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({
      message: 'The organization’s owner count could not be read. Please contact support.',
    })
    .build();
}

function notAMemberResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(404)
    .body<ErrorResponse>({ message: 'That person is not a member of this organization.' })
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
