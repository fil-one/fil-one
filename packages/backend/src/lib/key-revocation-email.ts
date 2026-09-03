import { formatRegion } from '@filone/shared';
import type { OrgRole, AccessKeySummary } from '@filone/shared';
import validator from 'validator';
import { sendMail } from './mailer.js';
import type { OrgProfileItem } from './org-profile.js';
import { readUserProfile } from './user-profile.js';
import { withFallback } from './with-fallback.js';

/**
 * Tell a member which of their access keys stopped working.
 *
 * Email is the one channel that reaches somebody who is not in the console when
 * their client breaks, and a revoked key breaks a client with no warning
 * anywhere else. The console shows the admin what happened; nothing shows the
 * member until they next sign in.
 *
 * The keys lead, and what prompted them follows. A revocation can outlive the
 * change that started it — a pass that revokes two keys and is then refused a
 * third leaves the role where it was, and a removal can cancel after its keys
 * are already gone. In both cases the credentials are permanently gone and the
 * member has to be told, so the message cannot be built around a role change
 * that may not have happened.
 *
 * Best effort. Everything it reports has already happened by the time this
 * runs, so a failed send is logged and the change stands. A member whose
 * profile row carries no verified address gets nothing, and that is recorded
 * too.
 */

/** What prompted the revocation, when anything did. */
export type RevocationCause =
  /** Their role narrowed and the keys exceeded the new one. */
  | { kind: 'role_changed'; previousRole: OrgRole; role: OrgRole }
  /** They were removed from the org. */
  | { kind: 'removed' }
  /** The change was refused after these keys had already gone. */
  | { kind: 'change_failed' };

/**
 * The form every membership change tells the member through. The send cannot
 * fail the request, since everything it reports has already happened; and the
 * org is named from the profile row the change already read, falling back when
 * that row is missing rather than leaving a hole in the sentence.
 */
export async function notifyRevokedKeys({
  orgId,
  orgProfile,
  userId,
  changedBy,
  revoked,
  cause,
  source,
}: {
  orgId: string;
  orgProfile: OrgProfileItem | undefined;
  /** The member whose keys went. */
  userId: string;
  /** The admin who made the change, by verified email or by id. */
  changedBy: string;
  revoked: readonly AccessKeySummary[];
  cause: RevocationCause;
  /** The caller's log prefix, so a failed send is filed under the change. */
  source: string;
}): Promise<void> {
  await withFallback(
    () =>
      sendKeyRevocationEmail({
        userId,
        orgName: orgProfile?.name?.S ?? 'your organization',
        keys: revoked,
        cause,
        changedBy,
      }),
    undefined,
    { source, orgId },
  );
}

export async function sendKeyRevocationEmail({
  userId,
  orgName,
  keys,
  cause,
  changedBy,
}: {
  userId: string;
  orgName: string;
  keys: readonly AccessKeySummary[];
  cause: RevocationCause;
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

  const lines = {
    opening:
      keys.length === 1
        ? `An access key of yours in ${orgName} was revoked and has stopped working.`
        : `${keys.length} access keys of yours in ${orgName} were revoked and have stopped working.`,
    cause: causeSentence(cause, orgName),
    changedBy: `Changed by ${changedBy}.`,
    nextStep: nextStepSentence(cause),
  };

  await sendMail(
    {
      to: email,
      subject: `Your access keys in ${orgName} were revoked`,
      text: buildTextBody(lines, keys),
      html: buildHtmlBody(lines, keys),
      fromName: 'Fil One',
    },
    {
      source: 'key-revocation-email',
      logFields: { userId, revoked: keys.length, cause: cause.kind },
    },
  );
}

function causeSentence(cause: RevocationCause, orgName: string): string {
  switch (cause.kind) {
    case 'role_changed':
      return `Your role in ${orgName} changed from ${cause.previousRole} to ${cause.role}, and an access key cannot carry more than the role that holds it.`;
    case 'removed':
      return `You were removed from ${orgName}, and an access key does not outlive the membership that created it.`;
    case 'change_failed':
      // Deliberately vague about what was attempted: the member cannot act on
      // it, the admin has already been told, and describing a half-applied
      // change would raise questions this message cannot answer.
      return `An administrator was changing your access in ${orgName}. The change did not complete, but these keys had already been revoked and will not come back.`;
  }
}

function nextStepSentence(cause: RevocationCause): string {
  return cause.kind === 'removed'
    ? 'Ask an owner or admin of that organization if you still need access.'
    : 'Create a new key with the permissions your role allows, then point your client at it.';
}

/** A key as both bodies name it: what it was called, which one it was, and where. */
function describeKey(key: AccessKeySummary): string {
  const suffix = key.accessKeyIdSuffix ? ` (…${key.accessKeyIdSuffix})` : '';
  return `${key.keyName}${suffix} — ${formatRegion(key.region)}, created ${key.createdAt.slice(0, 10)}`;
}

interface BodyLines {
  opening: string;
  cause: string;
  changedBy: string;
  nextStep: string;
}

function buildTextBody(lines: BodyLines, keys: readonly AccessKeySummary[]): string {
  return [
    lines.opening,
    '',
    ...keys.map((key) => `  - ${describeKey(key)}`),
    '',
    lines.cause,
    lines.changedBy,
    '',
    lines.nextStep,
  ].join('\n');
}

function buildHtmlBody(lines: BodyLines, keys: readonly AccessKeySummary[]): string {
  const esc = validator.escape;
  return [
    `<p>${esc(lines.opening)}</p>`,
    '<ul>',
    ...keys.map((key) => `<li>${esc(describeKey(key))}</li>`),
    '</ul>',
    `<p>${esc(lines.cause)} ${esc(lines.changedBy)}</p>`,
    `<p>${esc(lines.nextStep)}</p>`,
  ].join('\n');
}
