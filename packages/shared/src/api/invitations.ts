import { z } from 'zod';
import { OrgRole } from './org.ts';

/**
 * Invitations: the only way a second member reaches an organization.
 *
 * An Owner or Admin invites an email address at or below their own management
 * ceiling; the invitation is a row with a status, and the email carries a
 * single-use token whose SHA-256 is all the row keeps. The wire shapes live here
 * because the console renders the same records the backend writes — the pending
 * list, the accept page's outcome, and the error codes a denial arrives as.
 *
 * What the wire never carries in either direction, except in the accept request
 * itself: the token. It is in the emailed link and nowhere else, which is why
 * the summary below has no field for it.
 */

/**
 * How long an invitation is good for.
 *
 * Fourteen days, checked against `expiresAt` when the row is read rather than
 * enforced by a DynamoDB TTL: a TTL delete would erase the record before the M2
 * audit export could show that the invitation ever existed, and "this link
 * expired" is a better answer than "this link never existed".
 */
export const INVITE_EXPIRY_DAYS = 14;

/**
 * The most invitations one org may have outstanding.
 *
 * What it bounds is how many addresses an org can have waiting at once, not how
 * much mail it can send: revoking frees a slot immediately, and re-inviting an
 * address that already has a live invitation replaces that one rather than
 * taking a second slot. Volume over time is a per-org send throttle, which the
 * API does not have — the ORGS_BETA allowlist is what stands in for it while
 * every account that can invite is one we admitted by hand.
 *
 * Small on purpose: a real team invites people a handful at a time.
 */
export const MAX_PENDING_INVITATIONS_PER_ORG = 25;

/**
 * Where an invitation is in its life.
 *
 * `pending` is the only status a token resolves from. Expiry is not a status:
 * the row stays `pending` and the reader compares `expiresAt` to now, so an
 * expired invitation is still visible to whoever asks why nobody joined.
 */
export const INVITATION_STATUSES = ['pending', 'accepted', 'revoked'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/**
 * One invitation as the console sees it.
 *
 * `expired` is computed by the server at read time from `expiresAt`, so the two
 * halves of the product cannot disagree about whether a link still works —
 * the console does not do date arithmetic to decide what to render.
 */
export interface InvitationSummary {
  inviteId: string;
  /** The address as the inviter typed it, which is what the email went to. */
  email: string;
  role: OrgRole;
  /** The member who issued it, as a user id. */
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  status: InvitationStatus;
  /** `expiresAt` is in the past. A pending invitation nobody can accept. */
  expired: boolean;
  /**
   * The last attempt to email this invitation did not reach SendGrid, so the row
   * is live and nobody has heard about it. Present only when that happened: the
   * console shows it so an operator can tell a dead row from one somebody is
   * simply ignoring, and re-inviting the same address replaces it.
   */
  lastSendFailed?: boolean;
}

/**
 * The role a caller may invite is bounded by their own ceiling
 * (`canManageTargetRole`), which the handler checks — the schema's job is only
 * to keep anything that is not one of the four roles out of a stored row.
 */
export const InvitedRoleSchema = z.enum(OrgRole, {
  message: 'Choose one of the organization roles.',
});

export const CreateInvitationSchema = z.object({
  email: z
    .string()
    .trim()
    .max(320, 'That email address is too long.')
    .email('Please provide a valid email address.'),
  role: InvitedRoleSchema,
});

export type CreateInvitationRequest = z.infer<typeof CreateInvitationSchema>;

/**
 * The created invitation, and whether the email actually went out.
 *
 * Reported rather than implied: the row and its token are committed before
 * SendGrid is called, and a send that fails leaves a usable invitation nobody
 * has heard about. The console tells the inviter to re-invite, which is the
 * retry — so this flag is the difference between an honest response and one
 * that claims a delivery we did not make.
 */
export interface CreateInvitationResponse {
  invitation: InvitationSummary;
  emailSent: boolean;
}

export interface ListInvitationsResponse {
  invitations: InvitationSummary[];
}

/**
 * Long enough that no plausible client sends a truncated token, short enough
 * that a pasted blob is refused before it reaches a hash.
 */
export const INVITE_TOKEN_MIN_LENGTH = 20;
export const INVITE_TOKEN_MAX_LENGTH = 200;

export const AcceptInvitationSchema = z.object({
  token: z
    .string()
    .trim()
    .min(INVITE_TOKEN_MIN_LENGTH, 'That invitation link is not valid.')
    .max(INVITE_TOKEN_MAX_LENGTH, 'That invitation link is not valid.'),
});

export type AcceptInvitationRequest = z.infer<typeof AcceptInvitationSchema>;

/**
 * What the console needs to finish accepting: the org to switch into, its name
 * for the confirmation, and the role the new member now holds.
 *
 * The org id is in the response rather than left to a `/me` round trip because
 * the accept page's next act is to make that org active and reload.
 */
export interface AcceptInvitationResponse {
  orgId: string;
  orgName: string;
  role: OrgRole;
  /** The caller was already a member, so accepting changed only the invitation. */
  alreadyMember: boolean;
}
