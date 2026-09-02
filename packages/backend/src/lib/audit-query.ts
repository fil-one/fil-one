import { QueryCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { AUDIT_RETENTION_DAYS } from '@filone/shared';
import type { AuditEvent, AuditQueryFilters, AuditWindow } from '@filone/shared';
import { AuditKeys } from './audit.js';
import { getDynamoClient } from './ddb-client.js';
import type { DynamoCursor } from './ddb-paging.js';

/**
 * The audit log read path: one org's history, over a date range, optionally
 * narrowed to one event type and one actor.
 *
 * The write path is `audit.ts`, and the envelope both halves share is
 * `@filone/shared`.
 *
 * Two ways in, chosen by the filters. The base table is keyed
 * `ORG#{orgId}` / `{createdAt}#{eventId}`, so a date range is a `BETWEEN` on
 * the sort key and needs no index. Naming exactly one event type moves the same
 * query to the `byType` index, which is keyed the same way under
 * `ORG#{orgId}#TYPE#{type}`. Both partition keys are org-scoped, so neither
 * path can read across orgs whatever the filters say.
 *
 * The index was created after the log had already been written to, and
 * DynamoDB populates an index only from items that carry its key attributes. An
 * event written before that deploy is therefore absent from the type-filtered
 * path and present on the other, until its TTL removes it. The ADR records that
 * as an accepted gap rather than a backfill.
 */

/** The index that answers a single-type query. Declared in `sst.config.ts`. */
const EVENT_TYPE_INDEX = 'byType';

/** The name of the audit table, behind the narrowed `AuditLog` link. */
function auditTableName(): string {
  return Resource.AuditLog.name;
}

export interface AuditPage {
  events: AuditEvent[];
  window: AuditWindow;
  /** Absent when no further matching event exists in the window. */
  nextCursor?: string;
}

/** What a read costs, for the EMF the handler emits. */
export interface AuditQueryCost {
  /** DynamoDB round trips. The number worth watching against `rows`. */
  pages: number;
  rows: number;
}

export interface AuditQueryResult extends AuditPage {
  cost: AuditQueryCost;
}

/**
 * The window a request is actually served over.
 *
 * Retention is 90 days and a TTL enforces it, so a request reaching further
 * back is clamped rather than refused: the caller asked for history that no
 * longer exists, and the events that do exist are still the right answer. The
 * clamp is reported so the console can say so — silently returning a quarter to
 * someone who asked for half a year reads as data loss.
 *
 * A caller who named no lower bound gets the same window and is not told it was
 * clamped. They asked for the whole history rather than for more than exists,
 * and a console that announced a retention cut on every unfiltered page load
 * would train its reader to ignore the one time it matters.
 *
 * An upper bound in the future is left alone. It costs nothing, and clamping it
 * to "now" would make a range picked in a timezone ahead of UTC look truncated.
 */
export function resolveWindow(filters: Pick<AuditQueryFilters, 'from' | 'to'>): AuditWindow {
  const earliest = new Date(Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const clamped = filters.from !== undefined && filters.from < earliest;
  return {
    from: clamped || filters.from === undefined ? earliest : filters.from,
    to: filters.to,
    clamped,
  };
}

/**
 * One page of an org's history, newest first.
 *
 * The loop is the point. DynamoDB caps a Query at 1MB of items *examined* and
 * applies the `FilterExpression` afterwards, so a request narrowed to one actor
 * can read a megabyte, match nothing, and hand back a `LastEvaluatedKey`. A
 * handler that returned that response would show an empty page above a "next"
 * button, over and over, for a filter that does match something. So the read
 * keeps going until the page is full or the window is exhausted, and answers
 * only then.
 *
 * A cursor comes back only when a further matching event was actually seen, so
 * following one always yields at least one event and its absence is the end of
 * the history. That costs reading one event past the page: `LastEvaluatedKey`
 * proves only that more items were *examined*, and under a filter the window can
 * end on the page boundary, which would otherwise advertise a cursor whose page
 * comes back empty. It is the same `+1` {@link queryAllAuditEvents} uses to tell
 * reaching the export cap from landing on it exactly.
 */
export async function queryAuditEvents({
  orgId,
  filters,
  limit,
  cursor,
}: {
  orgId: string;
  filters: AuditQueryFilters;
  limit: number;
  cursor?: string;
}): Promise<AuditQueryResult> {
  const window = resolveWindow(filters);
  const cost: AuditQueryCost = { pages: 0, rows: 0 };
  // The row travels beside the event because the cursor is built from the
  // stored keys, which the event itself no longer carries.
  const matched: { item: Record<string, AttributeValue>; event: AuditEvent }[] = [];

  let startKey = cursor ? decodeCursor(cursor, orgId, filters) : undefined;

  drain: do {
    const page = await getDynamoClient().send(
      new QueryCommand(queryInput({ orgId, filters, window, startKey })),
    );
    cost.pages += 1;
    cost.rows += page.Items?.length ?? 0;

    for (const item of page.Items ?? []) {
      matched.push({ item, event: unmarshallAuditEvent(item) });
      if (matched.length > limit) break drain;
    }

    startKey = page.LastEvaluatedKey;
  } while (startKey);

  const page = matched.slice(0, limit);
  const events = page.map(({ event }) => event);
  // The extra match is the proof another page exists; the cursor names the last
  // event this response returned, and `ExclusiveStartKey` resumes after it.
  if (matched.length > limit) {
    const last = page[page.length - 1]!;
    return { events, window, nextCursor: encodeCursor(last.item, filters), cost };
  }

  return { events, window, cost };
}

/**
 * A stored row as the event it records.
 *
 * Named field by field rather than unmarshalled wholesale, for the reason
 * `auditItem` gives on the way in (`audit.ts`): `pk`, `sk`, `gsi1pk`, and
 * `gsi1sk` are where the row lives, not part of what it records, and they are
 * absent from the envelope in shared. A bare `unmarshall` would put the table
 * and index layout into every response and make the body disagree with
 * `ListAuditEventsResponse`.
 *
 * The keys still have to arrive — the cursor is derived from them — so they are
 * dropped here rather than projected away at the query.
 */
function unmarshallAuditEvent(item: Record<string, AttributeValue>): AuditEvent {
  const row = unmarshall(item) as AuditEvent;
  const { phase, correlationId, outcome } = row;

  return {
    eventId: row.eventId,
    type: row.type,
    actor: row.actor,
    orgId: row.orgId,
    subject: row.subject,
    details: row.details,
    createdAt: row.createdAt,
    ttl: row.ttl,
    ...(phase ? { phase, correlationId } : {}),
    ...(outcome ? { outcome } : {}),
    // Assembled from a union whose member TypeScript cannot pick without a
    // literal `type`, the same cast `auditEvent` needs on the write side.
  } as unknown as AuditEvent;
}

/**
 * Every event in the window, for the export.
 *
 * Stops at `maxRows`, and the caller decides whether reaching it is a refusal.
 * The same paging rule as the viewer, without a page to fill.
 */
export async function queryAllAuditEvents({
  orgId,
  filters,
  maxRows,
}: {
  orgId: string;
  filters: AuditQueryFilters;
  maxRows: number;
}): Promise<AuditQueryResult & { truncated: boolean }> {
  // One over the cap, so reaching it is distinguishable from landing on it
  // exactly. An export of exactly the cap is complete and must not be refused.
  const page = await queryAuditEvents({ orgId, filters, limit: maxRows + 1 });
  const truncated = page.events.length > maxRows;
  return { ...page, truncated };
}

/** The Query for whichever path the filters select. */
function queryInput({
  orgId,
  filters,
  window,
  startKey,
}: {
  orgId: string;
  filters: AuditQueryFilters;
  window: AuditWindow;
  startKey: DynamoCursor;
}) {
  const onIndex = filters.eventType !== undefined;
  const values: Record<string, unknown> = {
    ':pk': onIndex ? AuditKeys.typePk(orgId, filters.eventType!) : AuditKeys.orgPk(orgId),
    ':from': window.from,
    // The upper bound is exclusive, and `BETWEEN` is not. A sort key is
    // `{createdAt}#{eventId}`, so the bound with no `#` sorts before every
    // event stamped at that instant, which is the exclusivity the API promises.
    ':to': window.to,
    ':now': Math.floor(Date.now() / 1000),
  };

  const filterParts = [
    // An expired row is dropped here. DynamoDB deletes items on its own
    // schedule once their TTL passes and keeps serving them until it gets to
    // them, which can be 48 hours later; the promise made to the customer is 90
    // days, so the read enforces it rather than the sweeper.
    '#ttl > :now',
  ];
  const names: Record<string, string> = { '#ttl': 'ttl' };

  if (filters.actorId) {
    // Matched on the id alone. An id survives an address change, so a member who
    // changes email keeps one history, and it stays distinct when an address is
    // reused. `actor.email` is a display value that nothing filters on.
    filterParts.push('actor.id = :actorId');
    values[':actorId'] = filters.actorId;
  }

  return {
    TableName: auditTableName(),
    ...(onIndex ? { IndexName: EVENT_TYPE_INDEX } : {}),
    KeyConditionExpression: `${onIndex ? 'gsi1pk' : 'pk'} = :pk AND ${
      onIndex ? 'gsi1sk' : 'sk'
    } BETWEEN :from AND :to`,
    FilterExpression: filterParts.join(' AND '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: marshall(values),
    // Newest first.
    ScanIndexForward: false,
    ...(startKey ? { ExclusiveStartKey: startKey } : {}),
  };
}

/**
 * Where the next page resumes, as an opaque string.
 *
 * Only the sort key travels. The partition key is rebuilt from the caller's own
 * org on the way back in, so a cursor edited to name another org's partition
 * reads the caller's history instead of someone else's — the one thing a
 * client-supplied cursor must not be able to do.
 */
function encodeCursor(item: Record<string, AttributeValue>, filters: AuditQueryFilters): string {
  const sortKey = filters.eventType ? item.gsi1sk?.S : item.sk?.S;
  return Buffer.from(sortKey ?? '', 'utf8').toString('base64url');
}

function decodeCursor(
  cursor: string,
  orgId: string,
  filters: AuditQueryFilters,
): Record<string, AttributeValue> {
  const sortKey = Buffer.from(cursor, 'base64url').toString('utf8');
  return filters.eventType
    ? marshall({
        gsi1pk: AuditKeys.typePk(orgId, filters.eventType),
        gsi1sk: sortKey,
        // The index's own cursor carries the base table's key too, because an
        // index entry is addressed by both.
        pk: AuditKeys.orgPk(orgId),
        sk: sortKey,
      })
    : marshall({ pk: AuditKeys.orgPk(orgId), sk: sortKey });
}
