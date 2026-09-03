import type { OrgMembershipSource, OrgRole } from './api/org.js';
import { RAG_KEY_DISPLAY_PREFIX_LENGTH } from './api/rag-api-keys.js';

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
  'key.deleted',
  'audit.exported',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export function isAuditEventType(value: string): value is AuditEventType {
  return (AUDIT_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * The event types written as an `intent` before an external side effect and a
 * `completion` after it. Every other type is single-phase, and the envelope
 * types below make stamping a phase on one a compile error.
 *
 * Only the key flows: a credential is minted or revoked at the storage vendor
 * before any local write, so the local write cannot be the thing that
 * authorizes it. `key.created` also appears single-phase — a RAG key is minted
 * here rather than at a vendor, so its whole mutation is one transaction.
 */
export const TWO_PHASE_AUDIT_EVENT_TYPES = ['key.created', 'key.deleted'] as const;
export type TwoPhaseAuditEventType = (typeof TWO_PHASE_AUDIT_EVENT_TYPES)[number];

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
   * Verified only — an unverified claim names whoever typed it.
   */
  email?: string;
}

/**
 * Which half of a two-phase event this is.
 *
 * The flow records an `intent` before the vendor call and a `completion` after
 * it, sharing a `correlationId`. A crash between the two leaves a visible
 * dangling intent instead of an invisible credential.
 */
export const AUDIT_EVENT_PHASES = ['intent', 'completion'] as const;
export type AuditEventPhase = (typeof AUDIT_EVENT_PHASES)[number];

/**
 * How a two-phase flow ended, recorded on the `completion`.
 *
 * Every return path closes its correlation, including the ones that changed
 * nothing: a duplicate-name conflict and a vendor failure are `failed`, a
 * request that found nothing to do is `noop`. Without them a dangling intent
 * means either "the process died mid-flight" or "the request was rejected",
 * and an operator cannot tell which.
 */
export const AUDIT_OUTCOMES = ['succeeded', 'failed', 'noop'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * What an event is about, as `kind:id`.
 *
 * A template-literal union rather than a string, so a raw invitation token or a
 * bare access key id in the subject is a compile error rather than a value in
 * the log. Built by `AuditSubjects` in the backend, which is where the ids come
 * from.
 */
export type AuditSubject =
  | `org:${string}`
  | `user:${string}`
  | `invite:${string}`
  | `key:${string}`;

/** Which credential a key event is about: an S3 access key or a RAG API key. */
export type AuditKeyKind = 's3' | 'rag';

/**
 * A value an event payload may hold.
 *
 * Restricted to what `@aws-sdk/util-dynamodb` marshalls into a plain
 * attribute — object, array, string, number, boolean, null. A Set, Map, Date,
 * Buffer, or class instance either crashes the marshaller with no field name
 * attached or lands as a shape the viewer cannot read back, so the write path
 * rejects it by field path instead.
 */
export type AuditDetailValue =
  | string
  | number
  | boolean
  | null
  | AuditDetailValue[]
  | { [field: string]: AuditDetailValue | undefined };

/** A payload, as the guard and the marshaller both see it. */
export type AuditDetailRecord = { [field: string]: AuditDetailValue | undefined };

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
  'org.created': { orgName: string; source?: OrgMembershipSource };
  'org.renamed': { name: string; previousName?: string };
  'member.invited': {
    inviteId: string;
    email: string;
    role: OrgRole;
    /**
     * Live invitations to the same address this one replaced. Inviting an
     * address that already has one revokes it in the same transaction, so the
     * reader sees why a row they were looking at is suddenly revoked.
     */
    replacedInvitations?: number;
  };
  'invite.revoked': { inviteId: string; email: string };
  'invite.accepted': {
    inviteId: string;
    email: string;
    role: OrgRole;
    /**
     * The caller was already a member, so the accept marked the invitation and
     * granted nothing — the same honesty `key.created.recovered` carries about
     * which attempt did the work.
     */
    alreadyMember?: boolean;
  };
  'member.role_changed': {
    role: OrgRole;
    previousRole: OrgRole;
    /**
     * Pending invitations this change revoked, because an invitation must not
     * outlive its issuer's authority. A count rather than a list of ids: the
     * revocations rode the same transaction as the role change, so the reader
     * needs to know they happened, and each revoked row still says for itself
     * that it is revoked.
     */
    revokedInvitations?: number;
  };
  'member.removed': { role: OrgRole; revokedInvitations?: number };
  'ownership.transferred': {
    fromUserId: string;
    toUserId: string;
    /**
     * Owner invitations the outgoing Owner had outstanding, which the transfer
     * revoked: an Admin cannot issue one, so they cannot keep one either.
     */
    revokedInvitations?: number;
  };
  'key.created': {
    keyKind: AuditKeyKind;
    keyName: string;
    region?: string;
    /** The characters of the key the console shows — see {@link auditKeyIdSuffix}. */
    keyIdSuffix?: string;
    /**
     * The key already existed at the vendor and this write recovered the local
     * row for it, so the record is honest about which of the two attempts
     * created the credential (`create-access-key.ts`).
     */
    recovered?: boolean;
  };
  'key.deleted': {
    keyKind: AuditKeyKind;
    keyName?: string;
    region?: string;
    /** The characters of the key the console shows — see {@link auditKeyIdSuffix}. */
    keyIdSuffix?: string;
  };
  /**
   * The one event written on a read path, and the highest-signal action the log
   * records: it is the one that takes an org's security history out of the
   * system. The filters travel with it, because who exported everything and who
   * exported one member's week are different acts.
   *
   * It means an export was produced, not that the bytes arrived. A client that
   * disconnects mid-transfer leaves a record of an export nobody received.
   * Nothing acts on the distinction, so the type stays single-phase.
   */
  'audit.exported': {
    /** The effective window, after clamping to {@link AUDIT_RETENTION_DAYS}. */
    from: string;
    to: string;
    /** Absent when the export was not filtered to one type. */
    eventType?: AuditEventType;
    /** The actor filtered on, which is a user id and never an address. */
    actorId?: string;
    rowCount: number;
  };
}

/**
 * Every registered payload holds only what the table can store. A compile error
 * here means a new event type carries a Date, a Set, or a nested class
 * instance, which the runtime guard would reject at the write.
 */
type RecordablePayloads<T extends { [K in keyof T]: AuditDetailRecord }> = T;
export type AuditEventDetailsAreRecordable = RecordablePayloads<AuditEventDetails>;

/** The envelope fields every event carries, whatever its type. */
interface AuditEventEnvelope<T extends AuditEventType> {
  /**
   * Unique per event and the second half of the sort key, so two events stamped
   * in the same millisecond are two rows rather than one overwriting the other.
   * A fresh random id per call, so it identifies the event and not the request:
   * two attempts at the same mutation write two events, which is what a reader
   * of a retried flow needs to see.
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
  subject: AuditSubject;
  details: AuditEventDetails[T];
  /** ISO-8601, and the first half of the sort key. */
  createdAt: string;
  /** Epoch seconds, {@link AUDIT_RETENTION_DAYS} after `createdAt`. */
  ttl: number;
}

/**
 * A single-phase event: the mutation and its record land in one transaction, so
 * a phase would be noise. `phase` and `correlationId` are typed as absent
 * rather than optional, which is what makes stamping one on `org.renamed` a
 * compile error.
 */
export interface AuditSinglePhase {
  phase?: undefined;
  correlationId?: undefined;
  outcome?: undefined;
}

/** The half written before the vendor call. It has no outcome yet. */
export interface AuditIntentPhase {
  phase: 'intent';
  /** Shared by an `intent` and its `completion`. */
  correlationId: string;
  outcome?: undefined;
}

/** The half written after it, which is where the outcome is known. */
export interface AuditCompletionPhase {
  phase: 'completion';
  correlationId: string;
  outcome: AuditOutcome;
}

/**
 * The phase fields a given event type may carry: either half for a two-phase
 * type, absence only for everything else. Absence leads the union so a caller
 * writing a single-phase event needs no narrowing of its own.
 */
export type AuditPhaseFields<T extends AuditEventType> =
  | AuditSinglePhase
  | (T extends TwoPhaseAuditEventType ? AuditIntentPhase | AuditCompletionPhase : never);

/**
 * One stored event.
 *
 * Generic over its type so the payload narrows with it: reading
 * `event.details.previousName` off an `org.renamed` type-checks, and reading it
 * off a `key.created` does not.
 */
export type AuditEventRecord<T extends AuditEventType = AuditEventType> = RecordPerKeyKind<
  T,
  AuditEventDetails[T] extends { keyKind: infer K } ? K : never
>;

/**
 * One member per key kind, so `details.keyKind` discriminates: a vendor-backed
 * key event and a locally minted one are separate members rather than one
 * member with a union-typed field.
 */
type RecordPerKeyKind<T extends AuditEventType, K> = [K] extends [never]
  ? AuditEventEnvelope<T> & AuditPhaseFields<T>
  : K extends AuditKeyKind
    ? Omit<AuditEventEnvelope<T>, 'details'> & {
        details: AuditEventDetails[T] & { keyKind: K };
      } & AuditPhaseFields<T>
    : never;

/** Any stored event, narrowable by `type`. */
export type AuditEvent = { [T in AuditEventType]: AuditEventRecord<T> }[AuditEventType];

/**
 * A key event whose credential lives at the storage vendor, so the local write
 * cannot be the thing that authorizes it.
 */
export type VendorBackedKeyEvent = Extract<AuditEvent, { details: { keyKind: 's3' } }>;

/**
 * An event that may ride a local transaction — what `commitAudited` accepts.
 *
 * Everything except a vendor-backed key event with no phase: that one names a
 * credential minted outside the transaction, so a single row recording it is a
 * half with nothing to pair it to.
 */
export type CommittableAuditEvent = Exclude<AuditEvent, VendorBackedKeyEvent & AuditSinglePhase>;

/**
 * A phased event — what `appendAuditEvent` accepts.
 *
 * The intersection is what makes it phased: extracting by `type` alone leaves
 * {@link AuditSinglePhase} leading the union, so an unphased `key.created`
 * would compile and land as a half with nothing to pair it to.
 */
export type TwoPhaseAuditEvent = Extract<AuditEvent, { type: TwoPhaseAuditEventType }> &
  (AuditIntentPhase | AuditCompletionPhase);

/**
 * An event that rides no local transaction — what `appendAuditEvent` accepts.
 *
 * Two shapes qualify, for opposite reasons. A phase half has no mutation to
 * travel with by construction: the `intent` precedes the vendor call, and a
 * `completion` may close a request that changed nothing. `audit.exported`
 * describes a read, so there is no mutation for it to be atomic with at all.
 *
 * Everything else goes through `commitAudited`, because everything else records
 * a local write that must not be able to land unrecorded.
 */
export type StandaloneAuditEvent =
  | TwoPhaseAuditEvent
  | (Extract<AuditEvent, { type: 'audit.exported' }> & AuditSinglePhase);

/**
 * What each event type reads as in the viewer and the CSV.
 *
 * Exhaustive over {@link AUDIT_EVENT_TYPES}, so adding a type without deciding
 * what it says to a reader is a compile error rather than a blank cell. The
 * envelope's own docblock makes the same point: an event nothing can label is
 * an event nobody reads.
 *
 * The subject and the actor are rendered beside the label, so the label carries
 * only what happened. It follows `ACTIVITY_ACTION_LABELS`
 * (`api/dashboard.ts`), which does the same for the dashboard feed.
 *
 * `retention_override.signed` is not here yet, but when FIL-1019 adds it the
 * label has to read as a signing: the event records that a URL was minted, and
 * it is redeemed at the vendor where its use cannot be logged.
 */
export const AUDIT_EVENT_TYPE_LABELS: Record<AuditEventType, string> = {
  'org.created': 'Organization created',
  'org.renamed': 'Organization renamed',
  'member.invited': 'Member invited',
  'invite.revoked': 'Invitation revoked',
  'invite.accepted': 'Invitation accepted',
  'member.role_changed': 'Role changed',
  'member.removed': 'Member removed',
  'ownership.transferred': 'Ownership transferred',
  'key.created': 'Key created',
  'key.deleted': 'Key deleted',
  'audit.exported': 'Audit log exported',
};

/**
 * The label for a stored event's type.
 *
 * The fallback humanizes the verb after the last dot, so a console running
 * behind a backend that has learned a new type renders something rather than an
 * empty cell. A stored event outlives the code that wrote it, and the viewer is
 * the last place that should go blank when the two disagree.
 */
export function getAuditEventTypeLabel(type: string): string {
  const label = AUDIT_EVENT_TYPE_LABELS[type as AuditEventType];
  if (label) return label;

  const verb = type.split('.').pop() ?? '';
  return verb ? verb.charAt(0).toUpperCase() + verb.slice(1).replaceAll('_', ' ') : 'Audit event';
}

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
 * Characters of an S3 access key id an event may record. The console renders
 * those ids in full, so a short suffix is enough to match an event against the
 * row an operator is looking at.
 */
export const AUDIT_KEY_ID_SUFFIX_LENGTH = 4;

/**
 * The characters of a key an event records, by kind.
 *
 * Whichever fragment the console already shows, because the point of the field
 * is that an operator reading an event can find the key it names. A RAG key is
 * listed by its leading display prefix (`sk_rag_AbC12`), an S3 access key by
 * its id in full — so a RAG event carries the prefix and an S3 event the
 * trailing four. Four trailing characters of a RAG token would correlate with
 * nothing on screen.
 */
export function auditKeyIdSuffix(keyKind: AuditKeyKind, keyId: string): string {
  return keyKind === 'rag'
    ? keyId.slice(0, RAG_KEY_DISPLAY_PREFIX_LENGTH)
    : keyId.slice(-AUDIT_KEY_ID_SUFFIX_LENGTH);
}

/**
 * Content classes that must never reach an audit event.
 *
 * Stated as classes rather than field names because a guard that only knows
 * field names fails the moment a secret is nested one level deeper or pasted
 * into a free-text value. The patterns below are how the write path enforces
 * the easy half; this list is the standard the whole write path is held to, and
 * what a reviewer checks a new event type against.
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
 * A denied name is a developer error, not customer data: nothing a user types
 * decides what a payload field is called, so the write path throws and the
 * event type never ships. Values are handled the other way round — see
 * {@link looksLikeCredential}.
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
  /access[_-]?key/i,
  /api[_-]?key/i,
  /key[_-]?hash/i,
  /signature/i,
  /session/i,
  /csrf/i,
  /recovery[_-]?code/i,
  /presigned/i,
  /signed[_-]?url/i,
  /card[_-]?number/i,
  /account[_-]?number/i,
]);

/** What a redacted value reads as in the log. */
export const AUDIT_REDACTED = '[REDACTED]';

/**
 * Length at which a run of base64-ish characters stops being plausible as a
 * name and starts being plausible as a key.
 */
export const AUDIT_SECRET_BLOB_MIN_LENGTH = 40;

const SECRET_BLOB_PATTERN = new RegExp(`[A-Za-z0-9+/=_-]{${AUDIT_SECRET_BLOB_MIN_LENGTH},}`, 'g');

/**
 * Value shapes that read as a credential wherever they appear.
 *
 * A full RAG bearer token (the prefix plus enough of its random tail to be the
 * token rather than the 12-character display prefix the console shows), an AWS
 * access key id, a SHA-256 digest — which for a RAG key IS the lookup key — and
 * a URL carrying a token or a signature.
 */
export const CREDENTIAL_VALUE_PATTERNS: readonly RegExp[] = Object.freeze([
  /sk_rag_[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /(^|[^0-9a-f])[0-9a-f]{64}([^0-9a-f]|$)/,
  /[?&](?:[a-z_-]*token|x-amz-signature|x-amz-credential|sig|signature)=/i,
]);

/**
 * Whether a value looks like a credential and must therefore be redacted
 * rather than stored.
 *
 * Redacted, not refused: a value can be something a customer typed. Key names
 * accept the same characters a token starts with, so a member may legitimately
 * name a key `sk_rag_ci`, and a throw there would make that customer's own key
 * unauditable — in the two-phase flow it would throw after the vendor already
 * minted the credential. So a suspicious value loses its content and the event
 * still lands.
 */
export function looksLikeCredential(value: string): boolean {
  if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))) return true;
  // A long, mixed-case, digit-bearing run: what random bytes look like in
  // base64 and what no name looks like.
  for (const run of value.match(SECRET_BLOB_PATTERN) ?? []) {
    if (/[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run)) return true;
  }
  return false;
}
