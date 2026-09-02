import { DELETION_CODE_TTL_MINUTES } from '@filone/shared';
import { sendMail } from './mailer.js';

/**
 * Send the account-deletion verification code. SendGrid direct: Auth0 already
 * sends all other product email through the same account and sender, so no
 * extra verification is needed. The secret only exists on staging/production —
 * dev stages log the code instead so the flow stays testable.
 */
export async function sendDeletionCodeEmail(params: {
  to: string;
  orgName: string;
  code: string;
}): Promise<void> {
  // The code stays out of the subject: subject lines surface on lock screens and
  // in mail-server logs, so leading with the OTP exposes a live code to anyone
  // who can see the notification without unlocking the device.
  const subject = 'Your Fil One account deletion code';
  const text = [
    `You requested to permanently delete your Fil One account and organization "${params.orgName}".`,
    '',
    `Your verification code is: ${params.code}`,
    '',
    `This code expires in ${DELETION_CODE_TTL_MINUTES} minutes.`,
    '',
    "If you didn't request this, ignore this email and consider changing your password.",
  ].join('\n');
  const html = `
    <p>You requested to permanently delete your Fil One account and organization <strong>${escapeHtml(params.orgName)}</strong>.</p>
    <p>Your verification code is:</p>
    <p style="font-size:28px;font-weight:bold;letter-spacing:6px;font-family:monospace">${params.code}</p>
    <p>This code expires in ${DELETION_CODE_TTL_MINUTES} minutes.</p>
    <p>If you didn't request this, ignore this email and consider changing your password.</p>
  `;

  const result = await sendMail(
    { to: params.to, subject, text, html, fromName: 'Fil One' },
    { source: 'deletion-email', logFields: { to: params.to } },
  );

  if (result.sent) return;
  if (result.reason === 'stage_sends_no_mail') {
    // The code, on a stage that sends no mail, so the deletion flow stays
    // testable there. Nowhere else: an OTP in a log is a credential in a log.
    console.warn('[deletion-email] No SendGrid key on this stage — code not emailed', {
      to: params.to,
      code: params.code,
    });
    return;
  }

  // Unlike an invitation, nothing is committed yet: the caller has a challenge
  // row and a caller waiting for a code that will never arrive, so the request
  // fails and they try again.
  throw new Error(
    result.reason === 'rejected'
      ? `SendGrid send failed (${result.status}): ${result.body}`
      : 'SendGrid send failed',
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
