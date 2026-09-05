import validator from 'validator';
import { sendMail } from './mailer.js';

/**
 * The organization-invitation email: its copy, and the fields a log line about
 * it may carry. The send itself is `mailer.ts`.
 */

export interface SendInvitationEmailParams {
  /**
   * The invited address as the inviter typed it. Normalization
   * (email-normalization.ts) exists to key identity, not to address mail — the
   * recipient should see the address they gave out.
   */
  to: string;
  /**
   * The same address lowercased. Log-only: every line this module writes names
   * the invitation by its ids and this address, so an operator reading a send
   * failure can find the row without the mail body being in the log.
   */
  emailNorm: string;
  /** Log-only, so a failure names the row it belongs to rather than an org name. */
  orgId: string;
  /** Log-only, and the id the audit event and the pending list both use. */
  inviteId: string;
  orgName: string;
  inviterName?: string;
  inviterEmail?: string;
  acceptUrl: string;
  /** ISO-8601, as stored on the invitation row. */
  expiresAt: string;
}

/**
 * A value safe to interpolate into the plain-text body.
 *
 * The HTML part escapes for markup; the text part has its own injection, and it
 * is line-based: a display name carrying CR or LF opens a new line in a body
 * whose lines a reader takes as ours ("Accept the invitation:" followed by
 * somebody else's URL). Control characters go the same way — they render as
 * nothing and hide what follows.
 */
function sanitizeTextValue(value: string): string {
  return value.replace(CONTROL_CHARACTERS, ' ').trim();
}

/**
 * Unicode's control category: C0 and C1, which is CR, LF, NUL, DEL and the rest.
 * Named by category rather than by code-point range, so the intent reads and no
 * control character has to be written into this file to say it.
 */
const CONTROL_CHARACTERS = /\p{Cc}+/gu;

/**
 * How the invitation names the person who sent it. Both fields are optional
 * because the inviter's profile may carry neither a display name nor a
 * verified email, and an invitation with an anonymous sender is still worth
 * delivering — a recipient who cannot tell who invited them can at least see
 * which organization.
 */
function describeInviter(inviterName?: string, inviterEmail?: string): string {
  if (inviterName && inviterEmail) return `${inviterName} (${inviterEmail})`;
  return inviterName ?? inviterEmail ?? 'Someone';
}

/**
 * The expiry as a reader can act on it. The stored value is ISO-8601 with a
 * timezone, which is precise and unreadable; UTC longhand is neither
 * ambiguous nor machine-flavoured. An unparseable value passes through
 * verbatim rather than becoming "Invalid Date" — a wrong-looking timestamp
 * still tells the recipient to hurry, and tells us to go look at the row.
 */
function formatExpiry(expiresAt: string): string {
  const parsed = new Date(expiresAt);
  return Number.isNaN(parsed.getTime()) ? expiresAt : parsed.toUTCString();
}

function buildSubject(orgName: string): string {
  return `You are invited to join ${orgName} on Fil One`;
}

function buildTextBody(params: SendInvitationEmailParams): string {
  const inviter = sanitizeTextValue(describeInviter(params.inviterName, params.inviterEmail));
  const orgName = sanitizeTextValue(params.orgName);
  return [
    `${inviter} invited you to join ${orgName} on Fil One.`,
    '',
    'Accept the invitation:',
    params.acceptUrl,
    '',
    `The invitation expires on ${formatExpiry(params.expiresAt)}. After that, ask for a new one.`,
    '',
    'If you were not expecting this invitation, you can ignore this email.',
  ].join('\n');
}

/**
 * Every interpolated value is escaped here, whatever the caller believes about
 * its own storage. An org name and an inviter name are user-supplied strings
 * that arrive in a recipient's mail client, which is the classic injection
 * target; double-escaping a value some other layer already escaped costs a
 * cosmetic `&amp;amp;`, while trusting it once costs an HTML-injection hole.
 *
 * `validator.escape` is the escaper the rest of the backend uses
 * (org-name-validation.ts), so no hand-rolled variant can drift from it. It
 * encodes `/` as `&#x2F;`, which makes an escaped URL look startling in the
 * raw source and decodes back to the exact URL in both an `href` and a text
 * node.
 */
function buildHtmlBody(params: SendInvitationEmailParams): string {
  const esc = validator.escape;
  const inviter = esc(describeInviter(params.inviterName, params.inviterEmail));
  const acceptUrl = esc(params.acceptUrl);
  const expiry = esc(formatExpiry(params.expiresAt));
  return [
    `<p>${inviter} invited you to join <strong>${esc(params.orgName)}</strong> on Fil One.</p>`,
    `<p><a href="${acceptUrl}">Accept the invitation</a></p>`,
    `<p>The invitation expires on ${expiry}. After that, ask for a new one.</p>`,
    `<p>If the link does not open, paste this into your browser:<br />${acceptUrl}</p>`,
    '<p>If you were not expecting this invitation, you can ignore this email.</p>',
  ].join('\n');
}

/**
 * How every line in this module names an invitation: by the ids that address the
 * row and the address it went to. Never the accept URL, and so never the token —
 * "logged by id, never by hash" is the convention the RAG key rows already hold
 * to, and a token in a log is a token in a log aggregator.
 */
function invitationLogFields(params: SendInvitationEmailParams) {
  return {
    orgId: params.orgId,
    inviteId: params.inviteId,
    emailNorm: params.emailNorm,
    orgName: params.orgName,
  };
}

/**
 * Send the invitation. Returns true only when SendGrid accepted the message for
 * delivery — a no-op stage and a failed send both return false, because in
 * neither case is anything on its way to the recipient.
 *
 * Sending never throws. The caller has already committed the invitation row
 * before it reaches here, and the row is the invitation; the email is only its
 * announcement.
 */
export async function sendInvitationEmail(params: SendInvitationEmailParams): Promise<boolean> {
  const result = await sendMail(
    {
      to: params.to,
      subject: buildSubject(params.orgName),
      text: buildTextBody(params),
      html: buildHtmlBody(params),
    },
    {
      source: 'invite-mailer',
      // Never the accept URL. The token is in it, and a token in a log is a
      // credential in whatever the logs are shipped to. A stage that needs a
      // working link needs a dev tool that mints one on demand.
      logFields: { ...invitationLogFields(params), expiresAt: params.expiresAt },
    },
  );

  return result.sent;
}
