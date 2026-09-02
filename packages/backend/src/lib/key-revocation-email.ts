import { REGION_LABELS, formatRegion } from '@filone/shared';
import type { OrgRole, RevokedKeySummary } from '@filone/shared';
import validator from 'validator';
import { sendMail } from './mailer.js';
import { readUserProfile } from './user-profile.js';

/**
 * Tell a member their access keys were revoked.
 *
 * Email is the one channel that reaches somebody who is not in the console when
 * their client breaks, and a revoked key breaks a client with no warning
 * anywhere else. The console shows the admin what happened; nothing shows the
 * member until they next sign in.
 *
 * Best effort. The keys are already revoked and the role is already written by
 * the time this runs, so a failed send is logged and the change stands. A
 * member whose profile row carries no verified address gets nothing, and that
 * is recorded too.
 */
export async function sendKeyRevocationEmail({
  userId,
  orgName,
  keys,
  previousRole,
  role,
  changedBy,
}: {
  userId: string;
  orgName: string;
  keys: readonly RevokedKeySummary[];
  previousRole: OrgRole;
  /** The role they now hold, or undefined when they were removed from the org. */
  role?: OrgRole | undefined;
  /** The admin who made the change, by verified email or by id. */
  changedBy: string;
}): Promise<void> {
  if (keys.length === 0) return;

  const email = (await readUserProfile(userId))?.email;
  if (!email) {
    console.warn('[key-revocation-email] No address for the member — revocation unannounced', {
      userId,
      revoked: keys.length,
    });
    return;
  }

  const subject = `Your access keys in ${orgName} were revoked`;
  const change = role
    ? `Your role in ${orgName} changed from ${previousRole} to ${role}, and an access key cannot carry more than the role that holds it.`
    : `You were removed from ${orgName}, and an access key does not outlive the membership that created it.`;

  await sendMail(
    {
      to: email,
      subject,
      text: textBody({ change, keys, changedBy, role }),
      html: htmlBody({ change, keys, changedBy, role }),
      fromName: 'Fil One',
    },
    { source: 'key-revocation-email', logFields: { userId, revoked: keys.length } },
  );
}

/** A key as both bodies name it: what it was called, which one it was, and where. */
function describeKey(key: RevokedKeySummary): string {
  const suffix = key.accessKeyIdSuffix ? ` (…${key.accessKeyIdSuffix})` : '';
  const region = REGION_LABELS[key.region] ? formatRegion(key.region) : key.region;
  return `${key.keyName}${suffix} — ${region}, created ${key.createdAt.slice(0, 10)}`;
}

function nextStep(role: OrgRole | undefined): string {
  return role
    ? 'Create a new key with the permissions your role allows, then point your client at it.'
    : 'Ask an owner or admin of that organization if you still need access.';
}

function textBody({
  change,
  keys,
  changedBy,
  role,
}: {
  change: string;
  keys: readonly RevokedKeySummary[];
  changedBy: string;
  role: OrgRole | undefined;
}): string {
  return [
    change,
    '',
    'These keys stopped working:',
    ...keys.map((key) => `  - ${describeKey(key)}`),
    '',
    `Changed by ${changedBy}.`,
    '',
    nextStep(role),
  ].join('\n');
}

function htmlBody({
  change,
  keys,
  changedBy,
  role,
}: {
  change: string;
  keys: readonly RevokedKeySummary[];
  changedBy: string;
  role: OrgRole | undefined;
}): string {
  const esc = (value: string) => validator.escape(value);
  return [
    `<p>${esc(change)}</p>`,
    '<p>These keys stopped working:</p>',
    '<ul>',
    ...keys.map((key) => `<li>${esc(describeKey(key))}</li>`),
    '</ul>',
    `<p>Changed by ${esc(changedBy)}.</p>`,
    `<p>${esc(nextStep(role))}</p>`,
  ].join('\n');
}
