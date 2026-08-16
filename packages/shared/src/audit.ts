import type { OrgRole } from './api/org.js';

/**
 * The audit event envelope: what the control plane appends and what the M2
 * viewer (FIL-1022) reads back.
 *
 * It lives in shared rather than in the backend because the viewer renders
 * these records field by field — an event type it does not know how to label is
 * a blank row — so the type union and the payload each type carries are the
 * contract between the two halves, not a backend detail.
 *
 * The shape is flat and CloudEvents-flavoured: an id, a type, who did it, which
 * org it happened in, what it happened to, a small payload, and a timestamp.
 * Nothing here is signed, chained, or canonicalized: the PRD asks for an
 * append-only log and the review thread dropped tamper-evidence from the claim,
 * so Merkle roots, KMS signing, and proof endpoints are not part of it.
 *
 * The write path (envelope construction, the prohibited-content guard, and the
 * transaction that appends an event beside its mutation) is
 * `packages/backend/src/lib/audit.ts`.
 */

/**
 * Every event type M1 may emit. A closed union rather than a free string: the
 * viewer maps each one to a sentence, and an event nothing can label is an
 * event nobody reads.
 *
 * Defined against this repo's own vocabulary — org, member, invite, key — and
 * deliberately not lifted from the orgauthaudit harvest, whose taxonomy is
 * generated from a permission registry FIL-1016 says not to adopt.
 *
 * Types are added, never repurposed: a stored event outlives the code that
 * wrote it, so changing what a type means rewrites history that is already on
 * disk.
 */
export const AUDIT_EVENT_TYPES = [
  'org.created',
  'org.renamed',
  'member.invited',
  'invite.revoked',
  'invite.accepted',
  'member.role_changed',
  'member.removed',
  'ownership.transferred',
  'key.created',
  'key.revoked',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export function isAuditEventType(value: string): value is AuditEventType {
  return (AUDIT_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * What kind of thing acted.
 *
 * Typed from the first event rather than stored as a bare user id, because the
 * SSO and SCIM era adds actors that are not people: a scheduled job that
 * deprovisions a member (`system`) and an identity provider that provisions one
 * (`connection`). Those arrive as a new kind rather than a second event schema
 * the viewer would have to reconcile forever.
 */
export const AUDIT_ACTOR_KINDS = ['user', 'system', 'connection'] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

export interface AuditActor {
  kind: AuditActorKind;
  /**
   * The user id, the job name, or the connection id, depending on `kind`. Not a
   * key that resolves anywhere for `system`: a job has no row to look up.
   */
  id: string;
  /**
   * The actor's verified email when there is one, so the viewer can name a
   * member who has since been removed and whose profile no longer resolves.
   */
  email?: string;
}

/**
 * Which half of a two-phase event this is.
 *
 * Only mutations with an external side effect carry it. A key is minted at the
 * storage vendor before any local write, so the local write cannot be the thing
 * that authorizes it: the flow records an `intent` before the vendor call and a
 * `completion` after it, sharing a `correlationId`. A crash between the two
 * leaves a visible dangling intent instead of an invisible credential.
 *
 * Absent means a single-phase event — a pure-DynamoDB mutation, where the
 * mutation and its record land in one transaction and a phase would be noise.
 */
export const AUDIT_EVENT_PHASES = ['intent', 'completion'] as const;
export type AuditEventPhase = (typeof AUDIT_EVENT_PHASES)[number];

/** How a member came to be in the org, as recorded on membership events. */
export type AuditMembershipSource = 'signup' | 'conversion' | 'invitation';

/** Which credential a key event is about: an S3 access key or a RAG API key. */
export type AuditKeyKind = 's3' | 'rag';

/**
 * The payload each event type carries, keyed by type.
 *
 * Deliberately small. The envelope records what changed and who changed it, not
 * the whole row: details are rendered as a sentence in the viewer, exported to
 * a customer's SIEM, and retained for 90 days, and every field added here is a
 * field somebody has to be sure carries no secret.
 *
 * The map is the registry the invitations and members PRs write against — a new
 * event type is a key here plus an entry in {@link AUDIT_EVENT_TYPES}, and the
 * constructor will not accept a payload that does not match.
 */
export interface AuditEventDetails {
  'org.created': { orgName: string; source: AuditMembershipSource };
  'org.renamed': { name: string; previousName?: string };
  'member.invited': { inviteId: string; email: string; role: OrgRole };
  'invite.revoked': { inviteId: string; email: string };
  'invite.accepted': { inviteId: string; email: string; role: OrgRole };
  'member.role_changed': { role: OrgRole; previousRole: OrgRole };
  'member.removed': { role: OrgRole };
  'ownership.transferred': { fromUserId: string; toUserId: string };
  'key.created': {
    keyKind: AuditKeyKind;
    keyName: string;
    region?: string;
    /** Last characters of the minted access key id — see {@link auditKeyIdSuffix}. */
    keyIdSuffix?: string;
    /**
     * The key already existed at the vendor and this write recovered the local
     * row for it, so the record is honest about which of the two attempts
     * created the credential (`create-access-key.ts`).
     */
    recovered?: boolean;
  };
  'key.revoked': { keyKind: AuditKeyKind; keyName?: string; region?: string };
}

/**
 * One stored event.
 *
 * Generic over its type so the payload narrows with it: reading
 * `event.details.previousName` off an `org.renamed` type-checks, and reading it
 * off a `key.created` does not.
 */
export interface AuditEventRecord<T extends AuditEventType = AuditEventType> {
  /**
   * Unique per event and part of the sort key, so two events stamped in the
   * same millisecond cannot overwrite each other. A consumer deduplicates
   * replays on it.
   */
  eventId: string;
  type: T;
  actor: AuditActor;
  orgId: string;
  /**
   * What the event is about, as `kind:id` — the member, invitation, key, or org
   * the action targeted. Built by `AuditSubjects` in the backend so the
   * vocabulary stays closed.
   */
  subject: string;
  details: AuditEventDetails[T];
  /** ISO-8601, and the first half of the sort key. */
  createdAt: string;
  /** Epoch seconds, {@link AUDIT_RETENTION_DAYS} after `createdAt`. */
  ttl: number;
  phase?: AuditEventPhase;
  /** Shared by an `intent` and its `completion`. */
  correlationId?: string;
}

/** Any stored event, narrowable by `type`. */
export type AuditEvent = { [T in AuditEventType]: AuditEventRecord<T> }[AuditEventType];

/**
 * How long an event survives: the IAM PRD's 90-day audit retention, carried
 * into the design by the M1 ADR (`docs/architectural-decisions/
 * 2026-08-organizations-roles-m1.md`, §6 Audit write path).
 *
 * Stamped as a TTL attribute at append rather than swept by a retention job,
 * so a record cannot outlive the promise made about it because a job stopped
 * running. The consequence is worth stating plainly: the M2 viewer sees only
 * what was written within the quarter before it shipped.
 */
export const AUDIT_RETENTION_DAYS = 90;

/**
 * Characters of an access key id an event may record.
 *
 * The console renders access key ids in full and RAG keys by a 12-character
 * display prefix, so there is no one house convention to inherit; a short
 * suffix is enough to match an event against the row the console shows without
 * the event itself carrying an identifier anybody could use.
 */
export const AUDIT_KEY_ID_SUFFIX_LENGTH = 4;

/** The trailing characters of an access key id, for `key.created` details. */
export function auditKeyIdSuffix(accessKeyId: string): string {
  return accessKeyId.slice(-AUDIT_KEY_ID_SUFFIX_LENGTH);
}

/**
 * Content classes that must never reach an audit event.
 *
 * Stated as classes rather than field names because a guard that only knows
 * field names fails the moment a secret is nested one level deeper or pasted
 * into a free-text value. The field patterns below are how the write path
 * enforces the easy half; this list is the standard the whole write path is
 * held to, and what a reviewer checks a new event type against.
 */
export const PROHIBITED_AUDIT_CONTENT = [
  'secret access keys and the full access key id they pair with',
  'RAG API key tokens and their hashes',
  'bearer tokens, access tokens, and refresh tokens',
  'session cookies and CSRF tokens',
  'invitation tokens and the URLs that carry them',
  'presigned URLs',
  'passwords, passphrases, and recovery codes',
  'object contents',
  'payment card and bank account numbers',
] as const;

/**
 * Field names an event may not carry, at any nesting depth.
 *
 * Necessary and explicitly not sufficient — see {@link PROHIBITED_AUDIT_CONTENT}
 * for what the write path actually has to guarantee.
 */
export const PROHIBITED_AUDIT_FIELD_PATTERNS: readonly RegExp[] = Object.freeze([
  /secret/i,
  /password/i,
  /passphrase/i,
  /token/i,
  /credential/i,
  /cookie/i,
  /bearer/i,
  /authorization/i,
  /private[_-]?key/i,
  /recovery[_-]?code/i,
  /presigned/i,
  /signed[_-]?url/i,
  /card[_-]?number/i,
  /account[_-]?number/i,
]);
