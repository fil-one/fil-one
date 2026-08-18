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
   */
  eventSk: (createdAt: string, eventId: string): string => `${createdAt}#${eventId}`,
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
 * email is enforced in one place: only a verified claim, because an unverified
 * one names whoever typed it and the viewer shows it as the member's identity.
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

/** What every event is built from, whatever its phase. */
interface AuditEventFields<T extends AuditEventType> {
  type: T;
  actor: AuditActor;
  orgId: string;
  subject: AuditSubject;
  details: AuditEventDetails[T];
}

/**
 * A single-phase event: the mutation and its record land in one transaction, so
 * `phase` is typed as absent rather than optional. Stamping one on
 * `org.renamed` picks no overload and is a compile error.
 */
export type AuditEventInput<T extends AuditEventType> = AuditEventFields<T> & AuditSinglePhase;

/**
 * Half of a two-phase pair. `phase` and `correlationId` arrive together and a
 * `completion` arrives with its outcome, so an unpairable record and an
 * outcomeless completion are both compile errors.
 */
export type PhasedAuditEventInput<T extends TwoPhaseAuditEventType> = AuditEventFields<T> &
  (AuditIntentPhase | AuditCompletionPhase);

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
 * error rather than a runtime check.
 */
export function auditEvent<T extends AuditEventType>(
  input: AuditEventInput<T>,
): Extract<AuditEvent, { type: T }>;
export function auditEvent<T extends TwoPhaseAuditEventType>(
  input: PhasedAuditEventInput<T>,
): Extract<AuditEvent, { type: T }>;
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
 * The keys are derived last, so a stored row spread back into an event cannot
 * carry a `pk` or `sk` that disagrees with its own `orgId` and `createdAt`.
 */
function auditItem(event: AuditEvent): Record<string, unknown> {
  return {
    ...event,
    details: recordableDetails(event.details),
    pk: AuditKeys.orgPk(event.orgId),
    sk: AuditKeys.eventSk(event.createdAt, event.eventId),
  };
}

/** The table name and marshalled item every audit write shares. */
function auditWriteInput(event: AuditEvent): {
  TableName: string;
  Item: Record<string, AttributeValue>;
} {
  return {
    TableName: Resource.AuditTable.name,
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
 * Only for the `intent` half of a provider-backed mutation, which by definition
 * has no local write to ride with — everything else uses {@link commitAudited}.
 *
 * Not create-only. An automatic SDK retry after a lost response collides with
 * its own landed write, and a create-only condition would turn that into a
 * failed mutation: an intent Put re-landing identically is the retry working.
 */
export async function appendAuditEvent(event: TwoPhaseAuditEvent): Promise<void> {
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
  event: AuditEvent;
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
   * `details` are merged over the intent's, so the completion carries what only
   * the vendor could supply (the key id, the timestamp it stamped) without the
   * caller restating the rest.
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
        details: { ...details, ...completionDetails },
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
