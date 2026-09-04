import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { AcceptInvitationSchema, ApiErrorCode, OrgRole } from '@filone/shared';
import type { AcceptInvitationResponse, ErrorResponse } from '@filone/shared';
import { AuditSubjects, auditEvent, commitAudited, userActor } from '../lib/audit.js';
import {
  isInvitationUsable,
  normalizeInviteEmail,
  resolveInvitationByToken,
  retireInvitationItems,
} from '../lib/invitations.js';
import type { InvitationRecord } from '../lib/invitations.js';
import {
  cancelledLabels,
  inviterAuthorityCheck,
  membershipRows,
  ownerCountItem,
} from '../lib/membership-changes.js';
import { resolveMembership } from '../lib/org-membership.js';
import {
  OrgDeletingError,
  isGuardRejection,
  orgNotDeletingCheck,
  resolveOrgSummary,
} from '../lib/org-profile.js';
import { parseJsonBody } from '../lib/parse-json-body.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.js';
import { readUserProfile, rememberVerifiedEmail } from '../lib/user-profile.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

/**
 * POST /api/invitations/accept — join the organization an invitation names.
 *
 * The one org route with no org gate, and it has to be: the caller is not a
 * member of the inviting org yet, so a membership check here would refuse every
 * invitation there is. Authorization is the token plus a session whose VERIFIED
 * email matches the invitation — the token alone must not admit whoever a
 * forwarded email reaches.
 *
 * What the request never touches is as load-bearing as what it does. No
 * entitlement row, no Stripe call, no billing read: an invitation must not
 * create a trial, must not resurrect suppressed eligibility, and must not burn
 * the invitee's own claim, which stays available for their personal org (ADR §4,
 * §5). Those three are pinned by tests in the billing chain; the test here is
 * simply that this path makes no such call.
 *
 * Everything else lands in one transaction:
 *
 * - a `ConditionCheck` that the org is not being deleted, the same profile
 *   fence every guarded writer carries, as item 0,
 * - the same fence on the ACCEPTER's own org, when it is a different one: their
 *   deletion is what would end their identity while this membership is written,
 * - the membership row and its inverse item,
 * - the invitation marked accepted, conditional on it still being pending,
 * - the token lookup deleted, which is what makes the token single-use,
 * - `ownerCount + 1` when the invited role is Owner,
 * - a `ConditionCheck` that the INVITER still holds a role admitting that
 *   invitation, so an invitation cannot outlive its issuer's authority,
 * - and the audit event.
 *
 * After it lands, the accepter's verified address is stamped on their
 * `USER#{userId}/PROFILE` row. That is the row a removal reads to find the
 * invitations addressed TO the member it is removing, and acceptance is one of
 * only two moments the control plane learns a verified address.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { userId } = getUserInfo(event);
  const verifiedEmail = getVerifiedEmail(event);

  const parsed = parseJsonBody(event.body, AcceptInvitationSchema);
  if ('error' in parsed) return parsed.error;

  const invitation = await resolveInvitationByToken(parsed.data.token);
  // Expired, revoked, already accepted, never existed: one answer. The caller
  // holds a token and a session, so this is no probing oracle — it is the page
  // saying the link is done and offering to ask for another.
  if (!invitation || !isInvitationUsable(invitation)) return notFoundResponse();

  if (!verifiedEmail || normalizeInviteEmail(verifiedEmail) !== invitation.emailNorm) {
    return emailMismatchResponse();
  }

  const [existing, accepterOrgId] = await Promise.all([
    resolveMembership(invitation.orgId, userId),
    accepterOrgFence(userId, invitation.orgId),
  ]);
  const items = existing ? [] : joinItems(invitation, userId);
  const labels = existing ? [] : joinLabels(invitation);

  try {
    await commitAudited({
      // The fence is item 0, where `isGuardRejection` reads it, and it rides
      // both shapes of the transaction. An org resolving its teardown targets
      // must gain no member, and an invitation into it is no longer usable even
      // for somebody who is already inside.
      items: [
        orgNotDeletingCheck(invitation.orgId),
        ...(accepterOrgId ? [orgNotDeletingCheck(accepterOrgId)] : []),
        ...items,
        ...retireInvitationItems(invitation, 'accepted'),
      ],
      event: acceptedEvent({
        invitation,
        userId,
        verifiedEmail,
        alreadyMember: Boolean(existing),
      }),
    });
  } catch (err) {
    return await acceptFailureResponse(
      err,
      ['org', ...(accepterOrgId ? ['accepterOrg'] : []), ...labels, 'invitation', 'token'],
      { invitation, userId, verifiedEmail, accepterOrgId },
    );
  }

  await rememberVerifiedEmail(userId, verifiedEmail);

  return await acceptedResponse({
    invitation,
    role: existing?.role ?? invitation.role,
    alreadyMember: Boolean(existing),
  });
}

/**
 * The rows joining an org costs, in the order their labels name them.
 *
 * The inviter check is a `ConditionCheck` rather than a read before the
 * transaction, because a read cannot hold: an Admin demoted between the read and
 * the write would still mint a member. Demotion and removal revoke that member's
 * pending invitations, and this is the backstop for the window between them.
 */
function joinItems(invitation: InvitationRecord, userId: string): TransactWriteItem[] {
  return [
    ...membershipRows({
      orgId: invitation.orgId,
      userId,
      role: invitation.role,
      origin: {
        joinedAt: new Date().toISOString(),
        source: 'invitation',
        invitedBy: invitation.invitedBy,
      },
    }),
    inviterAuthorityCheck({
      orgId: invitation.orgId,
      invitedBy: invitation.invitedBy,
      invitedRole: invitation.role,
    }),
    ...(invitation.role === OrgRole.Owner ? [ownerCountItem(invitation.orgId, 'increment')] : []),
  ];
}

function joinLabels(invitation: InvitationRecord): string[] {
  return [
    'membership',
    'inverse',
    'inviter',
    ...(invitation.role === OrgRole.Owner ? ['ownerCount'] : []),
  ];
}

/**
 * The event, with the one field that says whether anything was granted.
 *
 * `alreadyMember` is the `key.created.recovered` idiom: a reader of the log sees
 * two shapes of success here — one that added a member and one that only spent
 * an invitation — and without the marker they are the same record.
 */
function acceptedEvent({
  invitation,
  userId,
  verifiedEmail,
  alreadyMember,
}: {
  invitation: InvitationRecord;
  userId: string;
  verifiedEmail?: string;
  alreadyMember: boolean;
}) {
  return auditEvent({
    type: 'invite.accepted',
    actor: userActor({ userId, email: verifiedEmail }),
    orgId: invitation.orgId,
    subject: AuditSubjects.invite(invitation.inviteId),
    details: {
      inviteId: invitation.inviteId,
      email: invitation.email,
      role: invitation.role,
      ...(alreadyMember ? { alreadyMember: true } : {}),
    },
  });
}

/**
 * Which of the transaction's conditions failed, as an answer the caller can act
 * on.
 *
 * The membership row's create-only condition is the interesting one: it fails
 * when the caller became a member while this request was in flight — two clicks
 * on the same link, or an admin adding them in parallel. That is the idempotent
 * case arriving by another route, so it re-reads and answers success rather than
 * telling somebody who is now a member that their invitation failed.
 */
async function acceptFailureResponse(
  err: unknown,
  labels: string[],
  { invitation, userId, verifiedEmail, accepterOrgId }: AcceptContext,
): Promise<APIGatewayProxyStructuredResultV2> {
  // The deletion fence, read at its own index. The answer is the one a revoked
  // invitation gets, and it says nothing about the org: a stale link should not
  // report that somebody's organization is being torn down.
  if (isGuardRejection(err)) return notFoundResponse();

  const failed = cancelledLabels(err, labels);
  if (failed.length === 0) throw err;

  // The accepter's own org is going away, so the answer is about their account
  // rather than about the invitation: the same one their next request would get
  // once the session fence's read catches up.
  if (failed.includes('accepterOrg')) throw new OrgDeletingError(accepterOrgId!);

  if (failed.includes('membership')) {
    const existing = await resolveMembership(invitation.orgId, userId);
    if (existing) {
      // The whole transaction cancelled, so the invitation is still pending: the
      // idempotent answer has to carry the retirement it promised, or a link the
      // caller has already used stays live for a fortnight.
      await retireAfterRace({ invitation, userId, verifiedEmail });
      if (verifiedEmail) await rememberVerifiedEmail(userId, verifiedEmail);
      return await acceptedResponse({ invitation, role: existing.role, alreadyMember: true });
    }
  }

  if (failed.includes('inviter')) return inviterAuthorityResponse();

  if (failed.includes('ownerCount')) {
    // The increment conditions on the counter existing, so this means an org
    // whose META row the conversion never wrote. Loud, because the last-Owner
    // invariant is unenforceable for that org until somebody repairs it.
    console.error('[accept-invitation] ownerCount missing — invitation to Owner refused', {
      orgId: invitation.orgId,
    });
    return ownerCountUnavailableResponse();
  }

  // The invitation's own condition: revoked, or accepted by another request,
  // between resolving the token and writing.
  return notFoundResponse();
}

interface AcceptContext {
  invitation: InvitationRecord;
  userId: string;
  verifiedEmail?: string;
  /** The accepter's own org, when the transaction fenced it. */
  accepterOrgId?: string;
}

/**
 * The accepter's own org, when it is one this transaction has to fence.
 *
 * `authMiddleware` refuses every request whose identity row names a deleting
 * org, which is the same check — but it is an eventually consistent read, and
 * the window it misses is the one that matters here. The deletion census reads
 * the accepter as a sole member and deletes their Auth0 identity; this request
 * commits a membership in another org a moment later; the result is a valid
 * membership whose user cannot sign in, and nothing repairs it.
 *
 * The org the census can end an account from is the org the identity row names:
 * `censusMember` deletes an identity only for a member whose sole membership is
 * not an invitation, and the home org moves only to an org the member still
 * belongs to (`repointHomeOrg`). The profile row carries the same value, moved
 * by the same repair, and this handler already holds the userId that addresses
 * it.
 *
 * Undefined when it is the inviting org — DynamoDB refuses two operations on one
 * item — and when the row cannot be read, which costs this transaction the
 * second fence and leaves it exactly as it was before.
 */
async function accepterOrgFence(
  userId: string,
  invitingOrgId: string,
): Promise<string | undefined> {
  const orgId = (await readUserProfile(userId, { consistentRead: true }))?.orgId;
  return orgId && orgId !== invitingOrgId ? orgId : undefined;
}

/**
 * Mark the invitation accepted after the join lost its race.
 *
 * Its own transaction, because the one it belonged to is gone. The status update
 * is still conditional on `pending`, so a revoke that landed in the meantime
 * wins and this cancels — which is the same outcome as never having tried, and
 * why the failure is logged rather than raised: the caller IS a member of the
 * org, which is what they asked for, and refusing them over the bookkeeping
 * would answer failure for a request that succeeded.
 */
async function retireAfterRace({
  invitation,
  userId,
  verifiedEmail,
}: AcceptContext): Promise<void> {
  try {
    await commitAudited({
      items: retireInvitationItems(invitation, 'accepted'),
      event: acceptedEvent({ invitation, userId, verifiedEmail, alreadyMember: true }),
    });
  } catch (err) {
    console.error('[accept-invitation] Membership landed but the invitation stayed pending', {
      orgId: invitation.orgId,
      inviteId: invitation.inviteId,
      error: err,
    });
  }
}

async function acceptedResponse({
  invitation,
  role,
  alreadyMember,
}: {
  invitation: InvitationRecord;
  role: OrgRole;
  alreadyMember: boolean;
}): Promise<APIGatewayProxyStructuredResultV2> {
  // The console sets the active org from this response and reloads, so it
  // needs the name (and logo, for the accepted panel's avatar) it is
  // switching to, as well as the id.
  const { name: orgName, logoUrl } = await resolveOrgSummary(invitation.orgId);

  return new ResponseBuilder()
    .status(200)
    .body<AcceptInvitationResponse>({
      orgId: invitation.orgId,
      orgName,
      ...(logoUrl ? { logoUrl } : {}),
      // A member who was already in the org keeps the role they hold: the
      // invitation is marked accepted, and accepting an invitation is not a way
      // to give somebody a role change nobody authorized.
      role,
      alreadyMember,
    })
    .build();
}

function notFoundResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(404)
    .body<ErrorResponse>({
      message: 'That invitation is no longer valid. Ask for a new one.',
      code: ApiErrorCode.INVITE_NOT_FOUND,
    })
    .build();
}

/**
 * Its own code, unlike the four misses above. The caller holds a valid token and
 * an authenticated session, so this is not a token-probing oracle — and under
 * SSO it is the difference between a debuggable "you are signed in with the
 * wrong account" and an opaque dead link.
 */
function emailMismatchResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(403)
    .body<ErrorResponse>({
      message:
        'This invitation was sent to a different email address than the one you signed in with.',
      code: ApiErrorCode.INVITE_EMAIL_MISMATCH,
    })
    .build();
}

function inviterAuthorityResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(403)
    .body<ErrorResponse>({
      message:
        'The person who invited you no longer has permission to add members. Ask an administrator for a new invitation.',
    })
    .build();
}

function ownerCountUnavailableResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({
      message: 'That organization cannot accept an owner right now. Please contact support.',
    })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  // The verified-email gate stays on: the whole check here is that the session's
  // VERIFIED address is the one the invitation went to.
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
