import { PutItemCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import {
  AUDIT_RETENTION_DAYS,
  PROHIBITED_AUDIT_FIELD_PATTERNS,
  RAG_KEY_TOKEN_PREFIX,
} from '@filone/shared';
import type {
  AuditActor,
  AuditEvent,
  AuditEventDetails,
  AuditEventPhase,
  AuditEventRecord,
  AuditEventType,
} from '@filone/shared';
import { getDynamoClient } from './ddb-client.js';

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
 *   goes through {@link commitAudited}: the mutation and a create-only event Put
 *   travel in one `TransactWriteItems`, so the mutation cannot land unrecorded.
 *   An AuditTable outage therefore blocks those control-plane writes, which the
 *   ADR accepts over an audit log with holes.
 * - A mutation with an external side effect cannot join that transaction. A key
 *   is minted at the storage vendor before any local write, and a fail-closed
 *   local transaction afterwards would leave a live credential with no record —
 *   worse than a hole in the log. Those flows call {@link appendAuditEvent} with
 *   an `intent` before the vendor call and commit a `completion` after it,
 *   sharing a {@link newCorrelationId}, so a crash between the two leaves a
 *   dangling intent somebody can see.
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
  org: (orgId: string): string => `org:${orgId}`,
  user: (userId: string): string => `user:${userId}`,
  invite: (inviteId: string): string => `invite:${inviteId}`,
  key: (keyId: string): string => `key:${keyId}`,
} as const;

/**
 * Thrown when an event carries content the log may not hold.
 *
 * A throw rather than a redaction: a silent scrub leaves a writer believing it
 * recorded something it did not, and every construction site here is a place a
 * developer is looking at while adding an event type. It fails in that
 * developer's test, not in production against a customer's data.
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
 * Longest string an event payload may carry. Long enough for an org name or an
 * email, short enough that a credential, a signed URL, or a pasted blob does
 * not fit.
 */
export const AUDIT_DETAIL_MAX_STRING_LENGTH = 256;

/** Deepest an event payload may nest. Details are a flat record in practice. */
const MAX_DETAIL_DEPTH = 4;

/**
 * Reject a payload carrying anything the log may not hold.
 *
 * Three checks, in the order they catch things: a field named for a credential
 * ({@link PROHIBITED_AUDIT_FIELD_PATTERNS}), a value carrying this product's own
 * key token prefix — the one credential shape the repo mints and can therefore
 * recognize by sight — and a value too long to be the identifier or name it
 * claims to be. The last is what stands between the log and a secret nobody
 * thought to name.
 *
 * The envelope's own fields are not walked: `actor`, `orgId`, `subject`, and
 * the timestamps are built here or by `AuditSubjects`, and `actor.email` is a
 * field the viewer exists to show.
 */
function assertPayloadIsRecordable(value: unknown, path: string, depth = 0): void {
  if (depth > MAX_DETAIL_DEPTH) {
    throw new ProhibitedAuditContentError(path, 'nests deeper than an audit payload may');
  }

  if (typeof value === 'string') return assertStringIsRecordable(value, path);

  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertPayloadIsRecordable(entry, `${path}[${index}]`, depth + 1),
    );
    return;
  }

  if (value === null || typeof value !== 'object') return;

  for (const [field, entry] of Object.entries(value)) {
    const fieldPath = `${path}.${field}`;
    if (PROHIBITED_AUDIT_FIELD_PATTERNS.some((pattern) => pattern.test(field))) {
      throw new ProhibitedAuditContentError(fieldPath, 'is named for prohibited content');
    }
    assertPayloadIsRecordable(entry, fieldPath, depth + 1);
  }
}

/** The half of the guard that looks at values rather than at field names. */
function assertStringIsRecordable(value: string, path: string): void {
  if (value.includes(RAG_KEY_TOKEN_PREFIX)) {
    throw new ProhibitedAuditContentError(path, 'carries an API key token');
  }
  if (value.length > AUDIT_DETAIL_MAX_STRING_LENGTH) {
    throw new ProhibitedAuditContentError(
      path,
      `is longer than ${AUDIT_DETAIL_MAX_STRING_LENGTH} characters`,
    );
  }
}

/** The id an `intent` and its `completion` share. */
export function newCorrelationId(): string {
  return crypto.randomUUID();
}

export interface AuditEventInput<T extends AuditEventType> {
  type: T;
  actor: AuditActor;
  orgId: string;
  subject: string;
  details: AuditEventDetails[T];
  phase?: AuditEventPhase;
  correlationId?: string;
}

/**
 * Build an event, stamped and checked.
 *
 * The id is a random UUID and the timestamp is the sort key's leading half, so
 * ordering comes from the clock and uniqueness from the id — a monotonic id
 * would buy nothing the pair does not already give, and two events written in
 * the same millisecond stay two rows.
 *
 * The prohibited-content check runs here, at construction, rather than at the
 * table: an event that cannot be recorded should never reach a transaction that
 * a mutation is riding in.
 */
export function auditEvent<T extends AuditEventType>(
  input: AuditEventInput<T>,
): AuditEventRecord<T> {
  const createdAt = new Date().toISOString();
  assertPayloadIsRecordable(input.details, 'details');

  return {
    eventId: crypto.randomUUID(),
    type: input.type,
    actor: input.actor,
    orgId: input.orgId,
    subject: input.subject,
    details: input.details,
    createdAt,
    ttl: auditTtl(createdAt),
    ...(input.phase ? { phase: input.phase } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
  };
}

/** Epoch seconds {@link AUDIT_RETENTION_DAYS} after the event was stamped. */
function auditTtl(createdAt: string): number {
  const expiresAt = new Date(createdAt).getTime() + AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return Math.floor(expiresAt / 1000);
}

/**
 * The event as a transaction item.
 *
 * Create-only: the log is append-only, so a Put that would land on an existing
 * key is a bug (a reused event id) and cancels the transaction rather than
 * overwriting history.
 */
export function auditPut(event: AuditEvent): TransactWriteItem {
  return {
    Put: {
      TableName: Resource.AuditTable.name,
      Item: marshall(auditItem(event), { removeUndefinedValues: true }),
      ConditionExpression: 'attribute_not_exists(pk)',
    },
  };
}

function auditItem(event: AuditEvent): Record<string, unknown> {
  return {
    pk: AuditKeys.orgPk(event.orgId),
    sk: AuditKeys.eventSk(event.createdAt, event.eventId),
    ...event,
  };
}

/**
 * Append an event on its own.
 *
 * Only for the `intent` half of a provider-backed mutation, which by definition
 * has no local write to ride with — everything else uses
 * {@link commitAudited}.
 */
export async function appendAuditEvent(event: AuditEvent): Promise<void> {
  await getDynamoClient().send(
    new PutItemCommand({
      TableName: Resource.AuditTable.name,
      Item: marshall(auditItem(event), { removeUndefinedValues: true }),
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
}

/**
 * Commit a mutation and its audit event as one transaction.
 *
 * The caller passes the items it would have written anyway; the event is
 * appended to them. Both land or neither does, across as many tables as the
 * caller already spans — signup's five items become six without changing shape.
 */
export async function commitAudited({
  items,
  event,
}: {
  items: TransactWriteItem[];
  event: AuditEvent;
}): Promise<void> {
  await getDynamoClient().send(
    new TransactWriteItemsCommand({ TransactItems: [...items, auditPut(event)] }),
  );
}
