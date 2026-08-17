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
  invitationSummary,
  inviteExpiresAt,
  listUsableInvitations,
  newInviteToken,
  normalizeInviteEmail,
} from '../lib/invitations.js';
import type { InvitationRecord } from '../lib/invitations.js';
import { resolveOrgName } from '../lib/org-profile.js';
import { hasOrgsBetaAccess } from '../lib/orgs-beta.js';
import { parseJsonBody } from '../lib/parse-json-body.js';
import { ResponseBuilder } from '../lib/response-builder.js';
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
 * - The **cap** on pending invitations, which is the only rate limit the API
 *   has. Revoking or accepting frees a slot.
 *
 * Then one transaction writes the invitation, its token lookup, and the audit
 * event, and only after it lands is the email sent. That order is deliberate: the
 * row is the invitation, the email is its announcement, and a send that fails
 * leaves a usable invitation the response reports honestly rather than a
 * rolled-back one. Re-inviting is the retry.
 *
 * The token exists in the email and in this response's absence: it is generated
 * here, hashed into the row, put in the accept URL, and never logged, never
 * audited, and never returned.
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
  if (!canManageTargetRole(callerRole, role)) return beyondCeilingResponse(role);

  if (!(await hasOrgsBetaAccess({ verifiedEmail: inviterEmail, orgId }))) return betaOnlyResponse();

  const pending = await listUsableInvitations(orgId);
  if (pending.length >= MAX_PENDING_INVITATIONS_PER_ORG) return capReachedResponse();

  const token = newInviteToken();
  const invitation = newInvitation({ orgId, email, role, invitedBy: userId, token });

  try {
    await commitAudited({
      items: invitationRows(invitation),
      event: auditEvent({
        type: 'member.invited',
        actor: userActor({ userId, email: inviterEmail }),
        orgId,
        subject: AuditSubjects.invite(invitation.inviteId),
        // The address and the role, never the token or the URL that carries it.
        details: { inviteId: invitation.inviteId, email, role },
      }),
    });
  } catch (err) {
    // Both rows are create-only and both keys are freshly minted, so a
    // cancellation here is a collision that cannot happen twice: report it as a
    // conflict and let the caller invite again with new keys.
    if (err instanceof TransactionCanceledException) return collisionResponse();
    throw err;
  }

  const emailSent = await sendInvitationEmail({
    to: email,
    orgName: await resolveOrgName(orgId),
    inviterName: name,
    inviterEmail,
    acceptUrl: acceptUrl(token),
    expiresAt: invitation.expiresAt,
  });

  return new ResponseBuilder()
    .status(201)
    .body<CreateInvitationResponse>({ invitation: invitationSummary(invitation), emailSent })
    .build();
}

function newInvitation({
  orgId,
  email,
  role,
  invitedBy,
  token,
}: {
  orgId: string;
  email: string;
  role: OrgRole;
  invitedBy: string;
  token: string;
}): InvitationRecord {
  const createdAt = new Date().toISOString();

  return {
    orgId,
    inviteId: crypto.randomUUID(),
    email,
    emailNorm: normalizeInviteEmail(email),
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
 * `WEBSITE_URL` rather than `resolveOrigin`, which honours a request header on
 * non-production stages. An origin an inviter can choose is an origin an
 * attacker can choose, and this URL goes to somebody else's inbox.
 */
function acceptUrl(token: string): string {
  return `${process.env.WEBSITE_URL}/invite/accept?token=${encodeURIComponent(token)}`;
}

function beyondCeilingResponse(role: OrgRole): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(403)
    .body<ErrorResponse>({
      message: `Your role in this organization cannot invite someone as ${role}.`,
      code: ApiErrorCode.FORBIDDEN_ROLE,
    })
    .build();
}

/**
 * The beta gate's refusal. No `ApiErrorCode`: the two role codes describe what a
 * caller's role permits, and this says the feature is not on for them yet — a
 * message the console renders as-is, the way the RAG gate's is.
 */
function betaOnlyResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(403)
    .body<ErrorResponse>({
      message: 'Inviting teammates is not enabled for this organization yet.',
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
