import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import {
  ApiErrorCode,
  CreateInvitationSchema,
  MAX_PENDING_INVITATIONS_PER_ORG,
  canManageTargetRole,
} from '@filone/shared';
import type { CreateInvitationResponse, ErrorResponse, OrgRole } from '@filone/shared';
import { AuditSubjects, auditEvent, commitAudited, userActor } from '../lib/audit.js';
import { sendInvitationEmail } from '../lib/invite-mailer.js';
import {
  hashInviteToken,
  invitationRows,
  inviteAddressClaimItem,
  invitationSummary,
  invitationsTo,
  inviteExpiresAt,
  listUsableInvitations,
  markInvitationSendFailed,
  newInviteToken,
  normalizeInviteEmail,
  planRevocations,
  readInviteAddressClaim,
  retireInvitationItems,
  revokeDeferred,
} from '../lib/invitations.js';
import type { InvitationRecord } from '../lib/invitations.js';
import {
  OrgDeletingError,
  isGuardRejection,
  orgNotDeletingCheck,
  resolveOrgName,
} from '../lib/org-profile.js';
import { hasOrgsBetaAccess } from '../lib/orgs-beta.js';
import { parseJsonBody } from '../lib/parse-json-body.js';
import { ResponseBuilder, beyondCeilingResponse } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo, getVerifiedEmail } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

/**
 * POST /api/org/invitations — invite an email address to the organization.
 *
 * Three checks stand between a caller and a stored invitation, and they are
 * different kinds of thing:
 *
 * - The **ceiling**: `members.manage` gets the caller here, and the role they
 *   asked for has to be one their own role may manage — Admins invite up to
 *   Admin, Owners can invite Owners. The registry answers it
 *   (`canManageTargetRole`), so "who may invite an Owner" stays a matrix
 *   question rather than a rank comparison.
 * - The **beta flag**, on creation only: an allowlist row for the caller or one
 *   for the org (`lib/orgs-beta.ts`). Accepting is never flagged — an invitee's
 *   experience must not depend on somebody else's allowlist status.
 * - The **cap** on live invitations, which counts addresses rather than
 *   attempts. Revoking or accepting frees a slot, and re-inviting an address
 *   that already has one takes no new slot at all.
 *
 * Then one transaction writes the invitation, its token lookup, any live
 * invitation to the same address it replaces, and the audit event, behind the
 * same org-deletion fence as item 0 that acceptance carries — an org resolving
 * its teardown targets must not gain an invitation row, a token lookup, and the
 * invitee's address after the enumeration that would have destroyed them. Only
 * after the transaction lands is the email sent. That order is deliberate: the row is the invitation,
 * the email is its announcement, and a send that fails leaves a usable
 * invitation the response reports honestly rather than a rolled-back one.
 *
 * Re-inviting is therefore the whole recovery story, and revoke-and-replace is
 * what makes it one. A failed send, a lost link, a mistyped role: invite the
 * address again and the old row is revoked and its token deleted in the same
 * transaction that writes the new one. An address never accumulates live
 * invitations, so it never accumulates working tokens — and the address claim
 * (`lib/invitations.ts`) is what holds that true for two FIRST invitations,
 * which have no row between them to collide on.
 *
 * The token exists in the email and in this response's absence: it is generated
 * here, hashed into the row, put in the accept URL's FRAGMENT — which reaches
 * neither servers, proxies, access logs, nor a front-end error reporter's URL
 * capture — and never logged, never audited, and never returned.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId, userId, membership, name } = getUserInfo(event);
  const inviterEmail = getVerifiedEmail(event);

  const parsed = parseJsonBody(event.body, CreateInvitationSchema);
  if ('error' in parsed) return parsed.error;
  const { email, role } = parsed.data;

  // `authorize('members.manage')` refused every caller without a membership row.
  const callerRole = membership!.role;
  if (!canManageTargetRole(callerRole, role)) {
    return beyondCeilingResponse(`invite someone as ${role}`);
  }

  if (!(await hasOrgsBetaAccess({ verifiedEmail: inviterEmail, orgId }))) return betaOnlyResponse();

  const emailNorm = normalizeInviteEmail(email);
  // The claim is read beside the cap's list because both are inputs to the same
  // transaction: the list says whether this invitation replaces one, the claim
  // says what the address currently holds and is what the write is conditioned
  // on.
  const [usable, claimedInviteId] = await Promise.all([
    listUsableInvitations(orgId),
    readInviteAddressClaim(orgId, emailNorm),
  ]);
  // Replaced rather than counted: this address already occupies whatever slot it
  // is going to occupy, so re-inviting cannot be how an org reaches the cap.
  const superseded = invitationsTo(usable, emailNorm);
  if (usable.length - superseded.length >= MAX_PENDING_INVITATIONS_PER_ORG) {
    return capReachedResponse();
  }

  const token = newInviteToken();
  const invitation = newInvitation({ orgId, email, emailNorm, role, invitedBy: userId, token });
  // The fence, the address claim and the two rows the new invitation is; the
  // rest of the transaction's room goes to the rows it supersedes. `later` is empty for any
  // org the cap has ever bounded — one address holds one live invitation — and
  // exists so that rows written before replacement existed cannot fail an
  // invite.
  const { now, later } = planRevocations(superseded, INVITATION_TRANSACTION_ITEMS);

  try {
    await commitAudited({
      items: [
        orgNotDeletingCheck(orgId),
        inviteAddressClaimItem({ record: invitation, claimedInviteId }),
        ...now.flatMap((replaced) => retireInvitationItems(replaced, 'revoked')),
        ...invitationRows(invitation),
      ],
      event: auditEvent({
        type: 'member.invited',
        actor: userActor({ userId, email: inviterEmail }),
        orgId,
        subject: AuditSubjects.invite(invitation.inviteId),
        // The address and the role, never the token or the URL that carries it.
        details: {
          inviteId: invitation.inviteId,
          email,
          role,
          ...(superseded.length > 0 ? { replacedInvitations: superseded.length } : {}),
        },
      }),
    });
  } catch (err) {
    // The fence, at its own index, where the org is going away and no remedy
    // exists — so it is the one cancellation that is not "try again".
    if (isGuardRejection(err)) throw new OrgDeletingError(orgId);
    // The new rows are create-only on freshly minted keys, so they cannot lose;
    // the address claim's condition can, when another invitation to the same
    // address landed while this request was in flight, and so can a replaced
    // row's, when an accept or a revoke did. Either way the caller's remedy is
    // the same one request: invite again against the state that now exists.
    if (err instanceof TransactionCanceledException) return collisionResponse();
    throw err;
  }

  await revokeDeferred(later);

  const emailSent = await sendInvitationEmail({
    to: email,
    emailNorm,
    orgId,
    inviteId: invitation.inviteId,
    orgName: await resolveOrgName(orgId),
    inviterName: name,
    inviterEmail,
    acceptUrl: acceptUrl(token),
    expiresAt: invitation.expiresAt,
  });
  // Stamped on the row, not just returned: the console's pending list is where
  // somebody later asks why nobody joined, and a row nobody was told about looks
  // exactly like a row somebody is ignoring.
  if (!emailSent) await markInvitationSendFailed(invitation);

  return new ResponseBuilder()
    .status(201)
    .body<CreateInvitationResponse>({
      invitation: invitationSummary({ ...invitation, lastSendFailed: !emailSent }),
      emailSent,
    })
    .build();
}

/**
 * The fence, the address claim, and the new invitation's two rows — what the
 * sweep of superseded invitations sits behind.
 */
const INVITATION_TRANSACTION_ITEMS = 4;

function newInvitation({
  orgId,
  email,
  emailNorm,
  role,
  invitedBy,
  token,
}: {
  orgId: string;
  email: string;
  emailNorm: string;
  role: OrgRole;
  invitedBy: string;
  token: string;
}): InvitationRecord {
  const createdAt = new Date().toISOString();

  return {
    orgId,
    inviteId: crypto.randomUUID(),
    email,
    emailNorm,
    role,
    invitedBy,
    status: 'pending',
    createdAt,
    expiresAt: inviteExpiresAt(createdAt),
    tokenHash: hashInviteToken(token),
  };
}

/**
 * Where the invitation link points: the console's accept route, which stashes
 * the token and bounces through login before calling the accept endpoint.
 *
 * The token rides the FRAGMENT, not the query. A fragment is never sent to a
 * server, so it is absent from access logs, proxy logs, referrer headers, and
 * the URL capture every front-end analytics and error reporter does by default;
 * a query parameter is present in all of them. The console reads it from
 * `location.hash`. Settled here rather than later because the first emailed link
 * fixes the shape for as long as that mail sits in an inbox.
 *
 * `WEBSITE_URL` rather than `resolveOrigin`, which honours a request header on
 * non-production stages. An origin an inviter can choose is an origin an
 * attacker can choose, and this URL goes to somebody else's inbox.
 */
function acceptUrl(token: string): string {
  return `${process.env.WEBSITE_URL}/invite/accept#token=${encodeURIComponent(token)}`;
}

/**
 * The beta gate's refusal, under its own code.
 *
 * The two role codes describe what a caller's role permits; this says the
 * feature is not on for them yet, and the console renders it as a state of the
 * form rather than a failed attempt. It needs a code of its own to be told from
 * the other code-less 403s this route can send — an expired CSRF cookie is the
 * routine one — which would otherwise be reported as the beta gate and take the
 * form off the page.
 */
function betaOnlyResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(403)
    .body<ErrorResponse>({
      message: 'Inviting teammates is not enabled for this organization yet.',
      code: ApiErrorCode.INVITES_NOT_ENABLED,
    })
    .build();
}

function capReachedResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({
      message: `This organization already has ${MAX_PENDING_INVITATIONS_PER_ORG} pending invitations. Revoke one before sending another.`,
      code: ApiErrorCode.INVITE_LIMIT_REACHED,
    })
    .build();
}

function collisionResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(409)
    .body<ErrorResponse>({ message: 'The invitation could not be created — please try again.' })
    .build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('members.manage'))
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
