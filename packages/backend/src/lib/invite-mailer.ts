import validator from 'validator';
import { Stage } from '@filone/shared';

/**
 * The organization-invitation email.
 *
 * Two behaviours, chosen by stage, because the credential the send needs does
 * not exist everywhere: `SendGridApiKey` is created only on staging and
 * production (sst.config.ts). Every other stage — a developer's `sst dev`, an
 * ephemeral PR stack, the e2e suite — gets the no-op mailer, which writes the
 * accept URL to the log. That is not a degraded fallback; it is how a test or a
 * developer obtains the invitation link at all, since no mailbox on those
 * stages would ever receive it.
 *
 * Sending never throws. The caller has already committed the invitation row
 * before it reaches here, and the row is the invitation — the email is only its
 * announcement. A thrown error would either roll back a valid invitation or
 * fail a request whose work already landed, so a failed send returns `false`
 * and re-inviting is the retry.
 */

const SENDGRID_MAIL_SEND_URL = 'https://api.sendgrid.com/v3/mail/send';

/**
 * The same from-address split the Auth0 email provider uses
 * (jobs/stack-setup/setup-integrations.ts): one verified sender domain, and a
 * `+staging` sub-address everywhere else so a message that escapes a
 * non-production stage is identifiable in the recipient's inbox rather than
 * indistinguishable from a real one.
 */
const PRODUCTION_FROM_ADDRESS = 'no-reply@filone.ai';
const NON_PRODUCTION_FROM_ADDRESS = 'no-reply+staging@filone.ai';

export interface SendInvitationEmailParams {
  /**
   * The invited address as the inviter typed it. Normalization
   * (email-normalization.ts) exists to key identity, not to address mail — the
   * recipient should see the address they gave out.
   */
  to: string;
  orgName: string;
  inviterName?: string;
  inviterEmail?: string;
  acceptUrl: string;
  /** ISO-8601, as stored on the invitation row. */
  expiresAt: string;
}

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
  const inviter = describeInviter(params.inviterName, params.inviterEmail);
  return [
    `${inviter} invited you to join ${params.orgName} on Fil One.`,
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
 * The SendGrid v3 send. `Resource` is imported here rather than at module
 * scope: on a stage without the secret the binding does not exist, and a
 * top-level import would make merely importing this module — which every stage
 * does, to reach the no-op branch — fail at load.
 */
async function sendThroughSendGrid(
  params: SendInvitationEmailParams,
  isProduction: boolean,
): Promise<boolean> {
  try {
    const { Resource } = await import('sst');

    const response = await fetch(SENDGRID_MAIL_SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${Resource.SendGridApiKey.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: params.to }] }],
        from: { email: isProduction ? PRODUCTION_FROM_ADDRESS : NON_PRODUCTION_FROM_ADDRESS },
        subject: buildSubject(params.orgName),
        content: [
          { type: 'text/plain', value: buildTextBody(params) },
          { type: 'text/html', value: buildHtmlBody(params) },
        ],
      }),
    });

    if (!response.ok) {
      // The body carries SendGrid's own reason (unverified sender, suppressed
      // recipient, quota). Never the Authorization header — that is the secret.
      const body = await response.text();
      console.error('[invite-mailer] SendGrid rejected the invitation email', {
        status: response.status,
        body,
        orgName: params.orgName,
      });
      return false;
    }

    return true;
  } catch (err) {
    console.error('[invite-mailer] SendGrid request failed', {
      orgName: params.orgName,
      error: err,
    });
    return false;
  }
}

/**
 * Send the invitation. Returns true only when SendGrid accepted the message for
 * delivery — a no-op stage and a failed send both return false, because in
 * neither case is anything on its way to the recipient.
 */
export async function sendInvitationEmail(params: SendInvitationEmailParams): Promise<boolean> {
  const stage = process.env.FILONE_STAGE!;

  if (stage === Stage.Production || stage === Stage.Staging) {
    return sendThroughSendGrid(params, stage === Stage.Production);
  }

  // The log line is the delivery mechanism on this stage, so it carries the
  // whole invitation: which address, which org, the URL that accepts it, and
  // when it stops working.
  console.log('[invite-mailer] Stage sends no email — invitation accept URL', {
    stage,
    to: params.to,
    orgName: params.orgName,
    acceptUrl: params.acceptUrl,
    expiresAt: params.expiresAt,
  });
  return false;
}
