import validator from 'validator';
import { DELETION_CODE_TTL_MINUTES } from '@filone/shared';
import {
  EMAIL_COLORS,
  EMAIL_MONO_FONT_STACK,
  renderEmailLayout,
  renderEmphasis,
  renderMetaParagraph,
  renderParagraph,
} from './email-layout.ts';
import { sendMail } from './mailer.ts';

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
  const html = renderEmailLayout({
    heading: 'Your account deletion code',
    // Never the code: the preview line shows on lock screens, which is why the
    // subject leaves it out too.
    preheader: 'Use this code to confirm deleting your Fil One account.',
    contentHtml: [
      renderParagraph(
        `You requested to permanently delete your Fil One account and organization ${renderEmphasis(params.orgName)}.`,
      ),
      renderCode(params.code),
      renderMetaParagraph(`This code expires in ${DELETION_CODE_TTL_MINUTES} minutes.`),
    ].join('\n'),
    footer: "If you didn't request this, ignore this email and consider changing your password.",
    consoleUrl: process.env.WEBSITE_URL,
  });

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

/** The code on a zinc-50 panel, spaced so it reads and copies digit by digit. */
function renderCode(code: string): string {
  return `<div style="margin:24px 0 0;padding:16px;background-color:${EMAIL_COLORS.zinc50};border:1px solid ${EMAIL_COLORS.zinc200};border-radius:8px;text-align:center;font-family:${EMAIL_MONO_FONT_STACK};font-size:28px;line-height:36px;font-weight:500;letter-spacing:6px;color:${EMAIL_COLORS.zinc900};">${validator.escape(code)}</div>`;
}
