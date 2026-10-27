import validator from 'validator';
import { sendMail } from './mailer.ts';

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
  const orgName = esc(params.orgName);
  const acceptUrl = esc(params.acceptUrl);
  const expiry = esc(formatExpiry(params.expiresAt));
  const logoUrl = getLogoUrl(params.acceptUrl);
  const logo = logoUrl
    ? `<img src="${esc(logoUrl)}" width="77" height="20" alt="Fil One" style="display:block;border:0;height:20px;width:77px;" />`
    : `<span style="font-size:16px;font-weight:500;color:${COLORS.zinc900};">Fil One</span>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>You are invited to join ${orgName} on Fil One</title>
</head>
<body style="margin:0;padding:0;background-color:${COLORS.zinc50};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${inviter} invited you to join ${orgName} on Fil One.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLORS.zinc50};">
<tr><td align="center" style="padding:48px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:440px;font-family:${FONT_STACK};">
<tr><td style="background-color:${COLORS.white};border:1px solid ${COLORS.zinc200};border-radius:12px;padding:32px;box-shadow:${AUTH_CARD_SHADOW};">
${logo}
<h1 style="margin:32px 0 0;font-size:16px;line-height:24px;font-weight:500;color:${COLORS.zinc900};">Join ${orgName} on Fil One</h1>
<p style="margin:12px 0 0;font-size:14px;line-height:20px;color:${COLORS.zinc600};">${inviter} invited you to join <span style="font-weight:500;color:${COLORS.zinc900};">${orgName}</span> on Fil One.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
<tr><td align="center" style="border-radius:6px;background-color:${COLORS.brand600};">
<a href="${acceptUrl}" style="display:block;padding:0 16px;font-size:14px;line-height:44px;font-weight:500;color:${COLORS.white};text-decoration:none;border-radius:6px;">Accept invitation</a>
</td></tr>
</table>
<p style="margin:16px 0 0;font-size:13px;line-height:19.5px;color:${COLORS.zinc500};">The invitation expires on ${expiry}. After that, ask for a new one.</p>
<hr style="margin:24px 0;border:0;border-top:1px solid ${COLORS.zinc200};" />
<p style="margin:0;font-size:12px;line-height:16px;color:${COLORS.zinc500};">If the button does not work, paste this link into your browser:</p>
<p style="margin:4px 0 0;font-size:12px;line-height:16px;word-break:break-all;"><a href="${acceptUrl}" style="color:${COLORS.brand600};text-decoration:none;">${acceptUrl}</a></p>
</td></tr>
<tr><td style="padding:20px 8px 0;font-size:12px;line-height:16px;color:${COLORS.zinc500};text-align:center;">If you were not expecting this invitation, you can ignore this email.</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * The console's design tokens (packages/website/src/styles/globals.css) as hex.
 * Mail clients read neither CSS variables nor `oklch()`, so each value is the
 * sRGB conversion of the token it is named after. Change one here when its
 * token changes.
 */
const COLORS = {
  white: '#ffffff',
  zinc50: '#fafafa',
  zinc200: '#e4e4e7',
  zinc500: '#71717b',
  zinc600: '#52525c',
  zinc900: '#18181b',
  brand600: '#055eff',
};

/**
 * The console's `--shadow-auth-card`, so the email reads as the same card as the
 * accept page it leads to. Clients that drop `box-shadow` (Gmail, Outlook) still
 * get the border.
 */
const AUTH_CARD_SHADOW = '0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06)';

/** Inter where the reader has it, then each platform's own UI font. */
const FONT_STACK =
  "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * The logo as a PNG (mail clients do not render SVG), served by the same
 * console the accept link opens. It sits under `/static/`, which the CloudFront
 * rewrite passes through to the bucket. An accept URL that does not parse yields
 * no logo rather than a throw, since sending never throws.
 */
function getLogoUrl(acceptUrl: string): string | undefined {
  try {
    return new URL('/static/email/fil-one-logo.png', acceptUrl).href;
  } catch {
    return undefined;
  }
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
      fromName: 'Fil One',
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
