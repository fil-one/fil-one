import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { OrgRole, TransferOwnershipSchema, canManageTargetRole } from '@filone/shared';
import type { ErrorResponse, TransferOwnershipResponse } from '@filone/shared';
import { AuditSubjects, auditEvent, commitAudited, userActor } from '../lib/audit.js';
import {
  pendingInvitationsFrom,
  planRevocations,
  retireInvitationItems,
  revokeDeferred,
} from '../lib/invitations.js';
import { cancelledLabels, ownerCountItem, roleChangeItems } from '../lib/membership-changes.js';
import { resolveMembership } from '../lib/org-membership.js';
import { OrgDeletingError, isGuardRejection, orgNotDeletingCheck } from '../lib/org-profile.js';
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

  try {
    await commitAudited({
      items: [
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
          // leaving the org, and an org that loses its only administrator
          // because somebody handed over ownership is a support ticket.
          toRole: OrgRole.Admin,
        }),
        ownerCountItem(orgId, 'unchanged'),
        ...now.flatMap((invitation) => retireInvitationItems(invitation, 'revoked')),
      ],
      event: auditEvent({
        type: 'ownership.transferred',
        actor: userActor({ userId, email: actorEmail }),
        orgId,
        subject: AuditSubjects.org(orgId),
        details: {
          fromUserId: userId,
          toUserId: targetUserId,
          ...(doomed.length > 0 ? { revokedInvitations: doomed.length } : {}),
        },
      }),
    });
  } catch (err) {
    return transferFailureResponse(err, orgId, now.length);
  }

  await revokeDeferred(later);

  return new ResponseBuilder()
    .status(200)
    .body<TransferOwnershipResponse>({ userId: targetUserId, previousOwnerUserId: userId })
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
    .body<ErrorResponse>({
      message: 'The organization’s roles changed while the transfer was in flight — try again.',
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
