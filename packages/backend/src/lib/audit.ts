import {
  PutItemCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import type {
  AttributeValue,
  CancellationReason,
  TransactWriteItem,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import {
  AUDIT_REDACTED,
  AUDIT_RETENTION_DAYS,
  PROHIBITED_AUDIT_FIELD_PATTERNS,
  auditKeyIdSuffix,
  looksLikeCredential,
} from '@filone/shared';
import type {
  AuditActor,
  AuditKeyKind,
  AuditDetailRecord,
  AuditDetailValue,
  AuditEvent,
  AuditEventDetails,
  AuditCompletionPhase,
  AuditEventPhase,
  AuditEventType,
  AuditIntentPhase,
  AuditSinglePhase,
  AuditOutcome,
  AuditSubject,
  CommittableAuditEvent,
  StandaloneAuditEvent,
  TwoPhaseAuditEvent,
  TwoPhaseAuditEventType,
} from '@filone/shared';
import { getDynamoClient } from './ddb-client.js';
import { reportMetric } from './metrics.js';

/**
 * The audit write path.
 *
 * Events go to their own table, AuditTable — pk `ORG#{orgId}`, sk
 * `{createdAt}#{eventId}` — so one Query per org returns its history newest-last
 * with no index, and the 90-day TTL that expires an event cannot reach a
 * membership or billing row that happened to share a partition.
 *
 * Every write also stamps `gsi1pk`/`gsi1sk` for the `byType` index, which is
 * what answers a viewer query filtered to a single event type. DynamoDB
 * populates an index only from items that already carry its key attributes, so
 * an event written without them is invisible to it for as long as it is stored.
 *
 * Two guarantees, chosen by whether the mutation is ours alone:
 *
 * - A pure-DynamoDB mutation (membership, roles, invitations, the org name)
 *   goes through {@link commitAudited}: the mutation and the event Put travel in
 *   one `TransactWriteItems`, so the mutation cannot land unrecorded. An
 *   AuditTable outage therefore blocks those control-plane writes, which the
 *   ADR accepts over an audit log with holes — except where blocking is worse
 *   than a hole, which the caller says with `onAuditFailure`.
 * - A mutation with an external side effect cannot join that transaction. A key
 *   is minted at the storage vendor before any local write, and a fail-closed
 *   local transaction afterwards would leave a live credential with no record —
 *   worse than a hole in the log. Those flows call {@link twoPhaseAudit}, which
 *   writes an `intent` before the vendor call and returns the handle that
 *   closes it afterwards.
 *
 * The envelope itself lives in `@filone/shared` — the M2 viewer (FIL-1022)
 * reads these records, and its labels and the writer's payloads are one
 * contract.
 */

/**
 * Every key AuditTable uses, in one builder.
 *
 * Membership-change rates put a single partition per org nowhere near
 * DynamoDB's per-partition write limits, so `ORG#{orgId}` is one partition on
 * purpose. If that ever stops being true, a shard suffix is added here and the
 * reader learns to fan out — no stored key changes meaning, so no data
 * migration.
 */
export const AuditKeys = {
  orgPk: (orgId: string): string => `ORG#${orgId}`,
  /**
   * Timestamp first so a Query returns an org's events in the order they
   * happened, and the event id after it so two events stamped in the same
   * millisecond are two rows rather than one overwriting the other.
   *
   * Also the sort key of {@link AuditKeys.typePk}'s index, so a type-filtered
   * query gets its date range from a `BETWEEN` on the same format.
   */
  eventSk: (createdAt: string, eventId: string): string => `${createdAt}#${eventId}`,
  /**
   * Partition key of the event-type index (`byType`), which answers a query
   * filtered to exactly one type.
   *
   * Still org-scoped, so a type filter can never read across orgs — the index
   * narrows what a reader sees within their own history and never widens it.
   */
  typePk: (orgId: string, type: AuditEventType): string => `ORG#${orgId}#TYPE#${type}`,
} as const;

/**
 * What an event is about, as `kind:id`.
 *
 * A closed vocabulary rather than free-form strings: the viewer groups an org's
 * history by subject ("everything that happened to this member"), and two
 * writers spelling the same target differently split that history in half.
 */
export const AuditSubjects = {
  org: (orgId: string): AuditSubject => `org:${orgId}`,
  user: (userId: string): AuditSubject => `user:${userId}`,
  invite: (inviteId: string): AuditSubject => `invite:${inviteId}`,
  /**
   * Kind-aware, because for an S3 access key the id IS the `AKIA…` access key
   * id, and PROHIBITED_AUDIT_CONTENT forbids the log holding that in full — the
   * details of the very same events carry only {@link auditKeyIdSuffix}. The
   * subject records the same fragment the details do, so the two agree and a
   * 90-day row never holds the full id. Correlating the two halves of a
   * two-phase flow runs off `correlationId`, not the subject.
   */
  key: (keyKind: AuditKeyKind, keyId: string): AuditSubject =>
    `key:${auditKeyIdSuffix(keyKind, keyId)}`,
} as const;

/**
 * The audit actor for an authenticated request.
 *
 * One builder rather than a literal at each call site, so the rule about the
 * email is stated in one place: callers pass only a verified claim, from
 * `getVerifiedEmail`, because an unverified one names whoever typed it and the
 * viewer shows it as the member's identity.
 */
export function userActor({ userId, email }: { userId: string; email?: string }): AuditActor {
  return { kind: 'user', id: userId, ...(email ? { email } : {}) };
}

/**
 * Thrown when an event carries a field the log may not hold.
 *
 * A throw rather than a redaction, because a denied field NAME is a developer
 * error: nothing a user types decides what a payload field is called, so this
 * fails in the test of whoever adds the event type. Suspicious field VALUES go
 * the other way — they may be customer data, so they are redacted and the event
 * still lands.
 */
export class ProhibitedAuditContentError extends Error {
  readonly path: string;

  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(`Audit event field "${path}" ${reason}`, options);
    this.name = 'ProhibitedAuditContentError';
    this.path = path;
  }
}

/**
 * Thrown when the audit half of a transaction is the half that failed.
 *
 * Its own type because handlers map a cancelled transaction to a 404 or a 409
 * about the entity they were writing — "this key is already gone", "this org
 * does not exist". A duplicate event id or a throttled audit partition means
 * nothing of the kind, and reporting a live key as revoked because the log
 * refused the write is the worse bug.
 */
export class AuditAppendError extends Error {
  constructor(reason: string, options?: ErrorOptions) {
    super(`Audit event could not be appended: ${reason}`, options);
    this.name = 'AuditAppendError';
  }
}

/**
 * Thrown when a completion contradicts the intent it closes.
 *
 * A developer error, like a prohibited field name: the two halves share one
 * correlation id, and a reader who finds them disagreeing about what the
 * operation was has no way to tell which half to believe.
 */
export class AuditCompletionConflictError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`Audit completion may not redefine "${field}", which its intent already recorded`);
    this.name = 'AuditCompletionConflictError';
    this.field = field;
  }
}

/**
 * Longest string an event payload may carry. Long enough for an org name or an
 * email, short enough that a credential, a signed URL, or a pasted blob does
 * not fit — a backstop, not the credential check, which is by shape.
 */
export const AUDIT_DETAIL_MAX_STRING_LENGTH = 256;

/** Deepest an event payload may nest. Details are a flat record in practice. */
const MAX_DETAIL_DEPTH = 4;

/** The most items DynamoDB accepts in one `TransactWriteItems`. */
export const TRANSACT_WRITE_ITEM_LIMIT = 100;

/**
 * Return the payload the log may hold, throwing on what it may not.
 *
 * A copy rather than a check in place, for two reasons. It is the deep copy that
 * stops a caller mutating `details` after construction and slipping past a
 * guard that has already run. And it is where a suspicious value is replaced:
 * the guard's two halves treat names and values differently on purpose.
 *
 * - A field NAME matching {@link PROHIBITED_AUDIT_FIELD_PATTERNS}, at any depth
 *   and including nested keys, throws. So does a value the table cannot
 *   store — a Date, a Set, a class instance — named by its field path rather
 *   than left to crash the marshaller with no path at all, and so does a
 *   payload nested deeper than an event has reason to be.
 * - A VALUE shaped like a credential ({@link looksLikeCredential}) is replaced
 *   with {@link AUDIT_REDACTED}. Key names accept the characters a token starts
 *   with, so this is a value a customer may have typed, and in a two-phase flow
 *   a throw here would fire after the vendor minted the credential.
 *
 * The envelope's own fields are not walked: `actor`, `orgId`, `subject`, and
 * the timestamps are built here or by {@link AuditSubjects}, and `actor.email`
 * is a field the viewer exists to show.
 */
function recordableDetails<T extends AuditEventType>(
  details: AuditEventDetails[T],
): AuditEventDetails[T] {
  return recordableValue(details, 'details', 0) as AuditEventDetails[T];
}

function recordableValue(value: unknown, path: string, depth: number): AuditDetailValue {
  if (depth > MAX_DETAIL_DEPTH) {
    throw new ProhibitedAuditContentError(path, 'nests deeper than an audit payload may');
  }

  if (typeof value === 'string') return recordableString(value, path);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    return value.map((entry, index) => recordableValue(entry, `${path}[${index}]`, depth + 1));
  }

  if (typeof value !== 'object' || !isPlainObject(value)) {
    throw new ProhibitedAuditContentError(
      path,
      `is a ${describeUnstorable(value)}, which an audit event cannot store`,
    );
  }

  return recordableFields(value, path, depth);
}

/** The fields of one object, with the name check run on every key. */
function recordableFields(value: object, path: string, depth: number): AuditDetailRecord {
  const copy: AuditDetailRecord = {};
  for (const [field, entry] of Object.entries(value)) {
    const fieldPath = `${path}.${field}`;
    if (PROHIBITED_AUDIT_FIELD_PATTERNS.some((pattern) => pattern.test(field))) {
      throw new ProhibitedAuditContentError(fieldPath, 'is named for prohibited content');
    }
    if (entry !== undefined) copy[field] = recordableValue(entry, fieldPath, depth + 1);
  }
  return copy;
}

/**
 * The half of the guard that looks at values rather than at field names: a
 * credential shape loses its content, and a string too long to be the name it
 * claims to be is a payload nobody meant to write.
 */
function recordableString(value: string, path: string): string {
  if (looksLikeCredential(value)) return AUDIT_REDACTED;
  if (value.length > AUDIT_DETAIL_MAX_STRING_LENGTH) {
    throw new ProhibitedAuditContentError(
      path,
      `is longer than ${AUDIT_DETAIL_MAX_STRING_LENGTH} characters`,
    );
  }
  return value;
}

/**
 * Whether the value marshalls as a plain map. A Date, Set, Map, Buffer, or class
 * instance does not: it either crashes `marshall` or lands as a shape the viewer
 * cannot read back, and inherited properties are not written at all.
 */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function describeUnstorable(value: unknown): string {
  if (typeof value !== 'object' || value === null) return typeof value;
  return value.constructor?.name ?? 'non-plain object';
}

/** The id an `intent` and its `completion` share. */
export function newCorrelationId(): string {
  return crypto.randomUUID();
}

/**
 * What every event is built from, whatever its phase.
 *
 * Generic over the payload as well as the type, so the `keyKind` a caller wrote
 * survives into the built event and {@link commitAudited} can tell a
 * vendor-backed key event from a locally minted one.
 */
interface AuditEventFields<
  T extends AuditEventType,
  D extends AuditEventDetails[T] = AuditEventDetails[T],
> {
  type: T;
  actor: AuditActor;
  orgId: string;
  subject: AuditSubject;
  details: D;
}

/**
 * A single-phase event: the mutation and its record land in one transaction, so
 * `phase` is typed as absent rather than optional. Stamping one on
 * `org.renamed` picks no overload and is a compile error.
 */
export type AuditEventInput<
  T extends AuditEventType,
  D extends AuditEventDetails[T] = AuditEventDetails[T],
> = AuditEventFields<T, D> & AuditSinglePhase;

/**
 * Half of a two-phase pair. `phase` and `correlationId` arrive together and a
 * `completion` arrives with its outcome, so an unpairable record and an
 * outcomeless completion are both compile errors.
 */
export type PhasedAuditEventInput<
  T extends TwoPhaseAuditEventType,
  D extends AuditEventDetails[T] = AuditEventDetails[T],
> = AuditEventFields<T, D> & (AuditIntentPhase | AuditCompletionPhase);

/**
 * What the constructor hands back: the union member for the type it was given,
 * narrowed to the key kind the caller wrote where there is one. The narrowing is
 * on `keyKind` alone rather than on the whole payload, because a payload written
 * without its optional fields is not the record type.
 */
type BuiltAuditEvent<T extends AuditEventType, D> = D extends { keyKind: infer K }
  ? Extract<Extract<AuditEvent, { type: T }>, { details: { keyKind: K } }>
  : Extract<AuditEvent, { type: T }>;

/** The phase fields as the constructor reads them, once the generic is erased. */
interface PhaseFieldsView {
  phase?: AuditEventPhase;
  correlationId?: string;
  outcome?: AuditOutcome;
}

/**
 * Build an event, stamped and checked.
 *
 * The id is a random UUID and the timestamp is the sort key's leading half, so
 * ordering comes from the clock and uniqueness from the id — a monotonic id
 * would buy nothing the pair does not already give, and two events written in
 * the same millisecond stay two rows.
 *
 * Returns the narrowed member of the union rather than the generic record, so a
 * wrapper that emits events for several types still hands back something whose
 * `type` switch narrows the payload.
 *
 * Two overloads rather than one conditional parameter, because only the event
 * types that call a vendor have two halves and the pairing is worth a compile
 * error rather than a runtime check. The phased overload also returns a phased
 * event, so what it builds is what {@link appendAuditEvent} takes.
 */
export function auditEvent<T extends AuditEventType, D extends AuditEventDetails[T]>(
  input: AuditEventInput<T, D>,
): BuiltAuditEvent<T, D> & AuditSinglePhase;
export function auditEvent<T extends TwoPhaseAuditEventType, D extends AuditEventDetails[T]>(
  input: PhasedAuditEventInput<T, D>,
): Extract<AuditEvent, { type: T }> & (AuditIntentPhase | AuditCompletionPhase);
export function auditEvent<T extends AuditEventType>(
  input: AuditEventFields<T> & PhaseFieldsView,
): Extract<AuditEvent, { type: T }> {
  const createdAt = new Date().toISOString();
  const { phase, correlationId, outcome } = input;

  return {
    eventId: crypto.randomUUID(),
    type: input.type,
    actor: input.actor,
    orgId: input.orgId,
    subject: input.subject,
    details: recordableDetails<T>(input.details),
    createdAt,
    ttl: auditTtl(createdAt),
    ...(phase ? { phase, correlationId } : {}),
    ...(outcome ? { outcome } : {}),
    // The fields are assembled from a union whose members TypeScript cannot
    // pick between until T is a literal; the input type is what enforces the
    // pairing, and it has already done so at the call site.
  } as unknown as Extract<AuditEvent, { type: T }>;
}

/** Epoch seconds {@link AUDIT_RETENTION_DAYS} after the event was stamped. */
function auditTtl(createdAt: string): number {
  const expiresAt = new Date(createdAt).getTime() + AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return Math.floor(expiresAt / 1000);
}

/**
 * The event as the table stores it.
 *
 * The guard runs here as well as at construction, because this is the funnel
 * every write goes through — `auditPut`, `appendAuditEvent`, `commitAudited` —
 * and a record built minutes ago, or read back and re-put, would otherwise
 * reach the table without one.
 *
 * The envelope is named field by field rather than spread. Structural typing
 * accepts an event-shaped value carrying an extra top-level field — a row read
 * back with a legacy attribute on it, a `{ ...event, accessKeyId }` at some
 * future call site — and a spread would marshal that field unchanged, past a
 * guard that only ever looks at `details`. What is not listed here does not
 * reach the table.
 *
 * The keys are derived last, so a stored row spread back into an event cannot
 * carry a `pk` or `sk` that disagrees with its own `orgId` and `createdAt`. The
 * index attributes are derived here for the same reason, and they are absent
 * from the envelope in shared for the same reason `pk` and `sk` are: they are
 * where the row lives, not part of what it records. Stamping them on every
 * write is what makes the `byType` index answer a type-filtered query — an
 * event written without `gsi1pk` is invisible to the index forever.
 */
function auditItem(event: AuditEvent): Record<string, unknown> {
  const { phase, correlationId, outcome } = event;

  return {
    eventId: event.eventId,
    type: event.type,
    actor: event.actor,
    orgId: event.orgId,
    subject: event.subject,
    details: recordableDetails(event.details),
    createdAt: event.createdAt,
    ttl: event.ttl,
    ...(phase ? { phase, correlationId } : {}),
    ...(outcome ? { outcome } : {}),
    pk: AuditKeys.orgPk(event.orgId),
    sk: AuditKeys.eventSk(event.createdAt, event.eventId),
    gsi1pk: AuditKeys.typePk(event.orgId, event.type),
    gsi1sk: AuditKeys.eventSk(event.createdAt, event.eventId),
  };
}

/** The table name and marshalled item every audit write shares. */
function auditWriteInput(event: AuditEvent): {
  TableName: string;
  Item: Record<string, AttributeValue>;
} {
  return {
    TableName: Resource.AuditLog.name,
    Item: marshall(auditItem(event), { removeUndefinedValues: true }),
  };
}

/**
 * The event as a transaction item.
 *
 * Create-only: inside a transaction a Put landing on an existing key means a
 * reused event id, which is a bug rather than a retry — the transaction carries
 * a `ClientRequestToken`, so DynamoDB deduplicates the retries itself.
 */
export function auditPut(event: AuditEvent): TransactWriteItem {
  return {
    Put: {
      ...auditWriteInput(event),
      ConditionExpression: 'attribute_not_exists(pk)',
    },
  };
}

/**
 * Append an event on its own.
 *
 * For an event with no local write to ride with: the `intent` of a
 * provider-backed mutation, which by definition has none, a `completion` whose
 * request made no mutation, and `audit.exported`, which describes a read.
 * Everything else uses {@link commitAudited}.
 *
 * Not create-only. An automatic SDK retry after a lost response collides with
 * its own landed write, and a create-only condition would turn that into a
 * failed mutation: an intent Put re-landing identically is the retry working.
 */
export async function appendAuditEvent(event: StandaloneAuditEvent): Promise<void> {
  await getDynamoClient().send(new PutItemCommand(auditWriteInput(event)));
}

/** What a caller wants to happen when the audit item is the one that fails. */
export type AuditFailureMode =
  /** Block the mutation. The ADR's default for a pure-DynamoDB change. */
  | 'fail'
  /**
   * Land the mutation without its event, then log and count it. For the writes
   * where blocking is the worse outcome: an audit outage must not lock every
   * new customer out of signup, nor stop a leaked key being revoked.
   */
  | 'retry-without-audit';

/**
 * Commit a mutation and its audit event as one transaction.
 *
 * The caller passes the items it would have written anyway; the event is
 * appended to them. Both land or neither does, across as many tables as the
 * caller already spans — signup's five items become six without changing shape.
 *
 * Takes everything except a vendor-backed key event with no phase. That one's
 * credential was minted outside the transaction, so the transaction is not what
 * authorized it and a lone row recording it pairs to nothing — those flows go
 * through {@link twoPhaseAudit}, whose completion rides the items instead.
 *
 * A cancelled transaction is unwrapped rather than rethrown blind, because the
 * caller's mapping of a cancellation ("that row was gone, so 404") is only true
 * when the caller's own item is the one that failed its condition. When the
 * audit item is, this either retries without it or raises
 * {@link AuditAppendError} — never a 404 about a key that is still live.
 */
export async function commitAudited({
  items,
  event,
  onAuditFailure = 'fail',
}: {
  items: TransactWriteItem[];
  event: CommittableAuditEvent;
  onAuditFailure?: AuditFailureMode;
}): Promise<void> {
  assertTransactionFits(items.length + 1);

  try {
    await getDynamoClient().send(
      new TransactWriteItemsCommand({
        TransactItems: [...items, auditPut(event)],
        // Deduplicates the SDK's own retries after a lost response: without it a
        // retried transaction re-runs its create-only conditions against the
        // items its first attempt already landed.
        ClientRequestToken: event.eventId,
      }),
    );
  } catch (err) {
    const auditFailure = auditOnlyCancellation(err, items.length);
    if (auditFailure) {
      if (onAuditFailure === 'fail') throw new AuditAppendError(auditFailure, { cause: err });
      await retryWithoutAudit({ items, event, reason: auditFailure });
      return;
    }

    // `retry-without-audit` exists so a mutation is not lost to the log, and a
    // whole-transaction refusal from the audit table strands exactly what it
    // protects: the vendor key is already deleted, the local row survives, and
    // the caller gets a 500. So a refusal that cannot have applied is treated
    // like the cancellation. Anything ambiguous still raises — a timeout or a
    // 5xx may have landed the write, and re-sending under a fresh token would
    // run the caller's items a second time.
    const refused = onAuditFailure === 'retry-without-audit' ? refusedOutright(err) : undefined;
    if (!refused) throw err;
    await retryWithoutAudit({ items, event, reason: refused });
  }
}

/**
 * Failures that refuse a whole transaction before any item is applied.
 *
 * A table DynamoDB does not have and a role that may not write it are both
 * decided before the write, so nothing landed and the caller's items can go
 * again on their own. Both are deploy-shaped — a missing table, a policy that
 * never granted the audit write — which is why they reach this path at all.
 */
const REFUSED_OUTRIGHT_ERRORS = new Set(['ResourceNotFoundException', 'AccessDeniedException']);

function refusedOutright(err: unknown): string | undefined {
  const name = err instanceof Error ? err.name : '';
  return REFUSED_OUTRIGHT_ERRORS.has(name) ? name : undefined;
}

/**
 * Send the caller's items alone, under a token of their own.
 *
 * A fresh `ClientRequestToken`: the first attempt's token belongs to a
 * transaction DynamoDB has already answered, and reusing it would have the
 * retry deduplicated against that answer.
 */
async function retryWithoutAudit({
  items,
  event,
  reason,
}: {
  items: TransactWriteItem[];
  event: AuditEvent;
  reason: string;
}): Promise<void> {
  reportAuditWriteFailure({ event, reason, action: 'retried without the event' });
  await getDynamoClient().send(
    new TransactWriteItemsCommand({
      TransactItems: items,
      ClientRequestToken: crypto.randomUUID(),
    }),
  );
}

/**
 * A clear failure rather than DynamoDB's, which arrives only once an org is big
 * enough to hit the limit in production. The event takes one of the hundred, so
 * a caller that already sends ninety-nine items has to batch.
 */
function assertTransactionFits(count: number): void {
  if (count > TRANSACT_WRITE_ITEM_LIMIT) {
    throw new Error(
      `Audited transaction needs ${count} items, ${TRANSACT_WRITE_ITEM_LIMIT} is the DynamoDB limit — split the mutation`,
    );
  }
}

/**
 * Why the audit item cancelled the transaction, or undefined when the
 * cancellation was the caller's own item failing its condition (or was not a
 * cancellation at all).
 *
 * The audit Put is appended last, so its reason is the one at `items.length`.
 */
function auditOnlyCancellation(err: unknown, mutationItemCount: number): string | undefined {
  if (!(err instanceof TransactionCanceledException)) return undefined;

  const reasons = err.CancellationReasons ?? [];
  const mutationFailed = reasons
    .slice(0, mutationItemCount)
    .some((reason) => didCancelTransaction(reason));
  if (mutationFailed) return undefined;

  const auditReason = reasons[mutationItemCount];
  if (!didCancelTransaction(auditReason)) return undefined;
  return auditReason.Code ?? 'cancelled';
}

function didCancelTransaction(
  reason: CancellationReason | undefined,
): reason is CancellationReason {
  return Boolean(reason?.Code) && reason?.Code !== 'None';
}

/**
 * The handle a two-phase flow closes its correlation with.
 *
 * Held rather than passed around as a bare id, because closing the correlation
 * means writing a completion with the same subject, actor, and correlation id as
 * the intent, and only the thing that wrote the intent knows all three.
 */
export interface AuditCorrelation<T extends TwoPhaseAuditEventType> {
  correlationId: string;
  /**
   * Write the `completion` half. Rides the caller's mutation items when the
   * flow has a local write to make, and goes on its own when it does not — a
   * request that returns 409 or 400 still closes its intent.
   *
   * `details` are merged over the snapshot the intent recorded, so the
   * completion carries what only the vendor could supply (the key id, the
   * timestamp it stamped) without the caller restating the rest. Adding a field
   * is what the completion is for; a field the intent already recorded is
   * invariant and redefining it throws.
   */
  complete(args: {
    outcome: AuditOutcome;
    details?: Partial<AuditEventDetails[T]>;
    items?: TransactWriteItem[];
  }): Promise<void>;
}

/**
 * Write the `intent` half of a two-phase flow and return the handle that closes
 * it.
 *
 * The failure mode is the caller's choice because it differs by operation, and
 * getting it backwards is the expensive kind of wrong:
 *
 * - `fail-closed` for minting. If the intent cannot be written the flow must
 *   abort before the vendor is called: no credential may exist without a record
 *   that somebody asked for it.
 * - `best-effort` for revoking. An AuditTable outage must never be the reason a
 *   leaked key stays live, so the intent failure is logged and counted and the
 *   revocation goes ahead — and the completion is attempted anyway, landing its
 *   mutation without the event if that is what it takes.
 */
export async function twoPhaseAudit<T extends TwoPhaseAuditEventType>({
  type,
  actor,
  orgId,
  subject,
  details,
  mode,
}: {
  type: T;
  actor: AuditActor;
  orgId: string;
  /**
   * One subject for both halves. A mint has no key id yet — it comes back from
   * the vendor — so its pair is filed under the org and the completion names
   * the key in `keyIdSuffix`; a revocation knows the id up front and files both
   * halves under the key.
   */
  subject: AuditSubject;
  details: AuditEventDetails[T];
  mode: 'fail-closed' | 'best-effort';
}): Promise<AuditCorrelation<T>> {
  const correlationId = newCorrelationId();
  const intent = auditEvent({
    type,
    actor,
    orgId,
    subject,
    details,
    phase: 'intent',
    correlationId,
  } as PhasedAuditEventInput<T>) as TwoPhaseAuditEvent;
  // The sanitized copy the intent recorded, not the caller's object: `details`
  // stays theirs to mutate after this returns, and the completion must say what
  // the intent said regardless.
  const intentDetails = intent.details as AuditEventDetails[T];

  try {
    await appendAuditEvent(intent);
  } catch (err) {
    if (mode === 'fail-closed') throw err;
    reportAuditWriteFailure({
      event: intent,
      reason: errorReason(err),
      action: 'continued without the intent',
    });
  }

  return {
    correlationId,
    complete: async ({ outcome, details: completionDetails, items }) => {
      const event = auditEvent({
        type,
        actor,
        orgId,
        subject,
        details: completedDetails<T>(intentDetails, completionDetails),
        phase: 'completion',
        correlationId,
        outcome,
      } as PhasedAuditEventInput<T>) as TwoPhaseAuditEvent;

      if (items?.length) {
        await commitAudited({
          items,
          event,
          onAuditFailure: mode === 'best-effort' ? 'retry-without-audit' : 'fail',
        });
        return;
      }

      try {
        await appendAuditEvent(event);
      } catch (err) {
        if (mode === 'fail-closed') throw err;
        reportAuditWriteFailure({
          event,
          reason: errorReason(err),
          action: 'continued without the completion',
        });
      }
    },
  };
}

/**
 * The completion's payload: what the intent recorded, plus what the vendor
 * supplied.
 *
 * `Partial<AuditEventDetails[T]>` would otherwise let a completion restate
 * `keyKind` or `keyName` as something else, and the pair filed under one
 * correlation id would disagree about which operation it describes. Restating a
 * field with the value it already has is allowed — that is a caller passing
 * back what it read, not a contradiction.
 */
function completedDetails<T extends TwoPhaseAuditEventType>(
  intentDetails: AuditEventDetails[T],
  completionDetails: Partial<AuditEventDetails[T]> | undefined,
): AuditEventDetails[T] {
  if (!completionDetails) return intentDetails;

  const recordable = recordableDetails<T>(completionDetails as AuditEventDetails[T]);
  const recorded = intentDetails as AuditDetailRecord;
  for (const [field, value] of Object.entries(recordable as AuditDetailRecord)) {
    if (recorded[field] !== undefined && !sameDetailValue(recorded[field], value)) {
      throw new AuditCompletionConflictError(field);
    }
  }

  return { ...intentDetails, ...recordable };
}

/** Structural equality over what a payload may hold: scalars, arrays, records. */
function sameDetailValue(
  a: AuditDetailValue | undefined,
  b: AuditDetailValue | undefined,
): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((entry, index) => sameDetailValue(entry, b[index]))
    );
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;

  const fields = Object.keys(a);
  return (
    fields.length === Object.keys(b).length &&
    fields.every((field) => sameDetailValue(a[field], (b as AuditDetailRecord)[field]))
  );
}

function errorReason(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * An audit write that did not land, on a path that chose not to fail for it.
 *
 * A log line alone is a hole nobody notices; the counter is what an alarm can
 * watch, so a table that has stopped accepting events shows up as a rate rather
 * than as an archaeology exercise after the fact.
 */
function reportAuditWriteFailure({
  event,
  reason,
  action,
}: {
  event: AuditEvent;
  reason: string;
  action: string;
}): void {
  console.error('[audit] event not recorded', {
    type: event.type,
    phase: event.phase,
    orgId: event.orgId,
    correlationId: event.correlationId,
    reason,
    action,
  });
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [['EventType']],
          Metrics: [{ Name: 'AuditEventDropped', Unit: 'Count' }],
        },
      ],
    },
    EventType: event.type,
    AuditEventDropped: 1,
  });
}
