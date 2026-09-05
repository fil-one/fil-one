import { Stage, senderAddress } from '@filone/shared';

/**
 * The one place product email leaves the console.
 *
 * Two behaviours, chosen by stage, because the credential a send needs does not
 * exist everywhere: `SendGridApiKey` is created only on staging and production
 * (sst.config.ts). Every other stage — a developer's `sst dev`, an ephemeral PR
 * stack, the e2e suite — sends nothing and says so.
 *
 * Sending never throws. Callers that must fail their request on a failed send
 * read the result and throw their own error; callers whose work is already
 * committed carry on. Either way the reason is logged here once, under the
 * caller's own prefix.
 *
 * Nothing a caller passes as a log field may be a credential. The invitation
 * token and the deletion code are both kept out of these lines by their
 * callers, and this module never reads the message body.
 */

const SENDGRID_MAIL_SEND_URL = 'https://api.sendgrid.com/v3/mail/send';

/**
 * A hung send must not hold a route open. Every caller has already committed
 * its own work, so a timeout is a failed send like any other.
 */
const SEND_TIMEOUT_MS = 5_000;

export interface MailMessage {
  /**
   * The recipient as a person gave it. Normalization exists to key identity,
   * not to address mail.
   */
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Display name beside the from-address, when the message wants one. */
  fromName?: string | undefined;
}

export interface MailContext {
  /** The prefix every line of this send is logged under, e.g. `invite-mailer`. */
  source: string;
  /** What names this message in a log. Ids and addresses, never a credential. */
  logFields: Record<string, unknown>;
}

export type MailResult =
  /** SendGrid accepted it for delivery. */
  | { sent: true }
  /** No SendGrid credential on this stage, so nothing was attempted. */
  | { sent: false; reason: 'stage_sends_no_mail' }
  /** SendGrid answered and refused. */
  | { sent: false; reason: 'rejected'; status: number; body: string }
  /** The request never got an answer: a network error, or the timeout. */
  | { sent: false; reason: 'request_failed' };

export async function sendMail(message: MailMessage, context: MailContext): Promise<MailResult> {
  const stage = process.env.FILONE_STAGE;
  if (stage !== Stage.Production && stage !== Stage.Staging) {
    console.log(`[${context.source}] Stage sends no email`, { stage, ...context.logFields });
    return { sent: false, reason: 'stage_sends_no_mail' };
  }

  return send(message, context, stage === Stage.Production);
}

/**
 * `Resource` is imported here rather than at module scope: on a stage without
 * the secret the binding does not exist, and a top-level import would make
 * merely importing this module — which every stage does, to reach the branch
 * above — fail at load.
 */
async function send(
  message: MailMessage,
  context: MailContext,
  isProduction: boolean,
): Promise<MailResult> {
  try {
    const { Resource } = await import('sst');

    const response = await fetch(SENDGRID_MAIL_SEND_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${Resource.SendGridApiKey.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: message.to }] }],
        from: {
          email: senderAddress(isProduction),
          ...(message.fromName ? { name: message.fromName } : {}),
        },
        subject: message.subject,
        content: [
          { type: 'text/plain', value: message.text },
          { type: 'text/html', value: message.html },
        ],
      }),
    });

    if (!response.ok) {
      // The body carries SendGrid's own reason (unverified sender, suppressed
      // recipient, quota). Never the Authorization header — that is the secret.
      const body = await response.text();
      console.error(`[${context.source}] SendGrid rejected the message`, {
        status: response.status,
        body,
        ...context.logFields,
      });
      return { sent: false, reason: 'rejected', status: response.status, body };
    }

    return { sent: true };
  } catch (err) {
    // A timeout arrives here too, as an AbortError, and is the same outcome.
    console.error(`[${context.source}] SendGrid request failed`, {
      ...context.logFields,
      error: err,
    });
    return { sent: false, reason: 'request_failed' };
  }
}
