import { DELETION_CODE_TTL_MINUTES, Stage } from '@filone/shared';
import { Resource } from 'sst';

/**
 * Send the account-deletion verification code. Uses the SendGrid API directly
 * (all other product email is sent by Auth0 through the same SendGrid account
 * and sender, so no extra sender verification is needed). The SendGridApiKey
 * secret only exists on staging/production — on ephemeral dev stages the code
 * is logged instead so the flow stays testable.
 */
export async function sendDeletionCodeEmail(params: {
  to: string;
  orgName: string;
  code: string;
}): Promise<void> {
  const stage = process.env.FILONE_STAGE;
  const isProduction = stage === Stage.Production;

  if (stage !== Stage.Production && stage !== Stage.Staging) {
    console.warn('[deletion-email] No SendGrid key on this stage — code not emailed', {
      to: params.to,
      code: params.code,
    });
    return;
  }

  const fromAddress = isProduction ? 'no-reply@filone.ai' : 'no-reply+staging@filone.ai';
  const subject = `${params.code} is your Fil One account deletion code`;
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

  const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Resource.SendGridApiKey.value}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: params.to }] }],
      from: { email: fromAddress, name: 'Fil One' },
      subject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html },
      ],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`SendGrid send failed (${resp.status}): ${body}`);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
