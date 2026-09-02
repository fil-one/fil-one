import { isAuditEventType } from '@filone/shared';
import type { AuditQueryFilters, AuditWindow } from '@filone/shared';

/** Both audit routes take the same filters; this is where they are read. */

/** A caller asked for something the query cannot be built from. */
export class AuditFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditFilterError';
  }
}

/** A UUID, which is what a `userId` is. Anything else cannot match an actor. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The filters, from the query string.
 *
 * An absent lower bound is left absent rather than filled in here, and
 * `resolveWindow` turns it into the oldest instant retention holds. That keeps
 * the retention boundary in one place, and it keeps "the caller asked for more
 * history than exists" distinguishable from "the caller asked for all of it" —
 * only the first is reported as a clamp. An absent upper bound is now, which
 * needs no such distinction.
 *
 * The default window is the whole quarter either way, because an auditor
 * opening the log wants to see it rather than discover a narrower default after
 * searching for a change they know happened.
 *
 * Timestamps are validated into the exact ISO-8601 form the sort key uses.
 * Accepting a date-only bound here would compare `2026-08-01` against
 * `2026-08-01T09:14:22.104Z#...` and quietly exclude everything on the closing
 * day, so a bound that is not a full instant is refused rather than widened —
 * the console does the widening, where it knows which end it is widening.
 */
export function parseAuditFilters(query: Record<string, string | undefined>): AuditQueryFilters {
  const to = query.to ?? new Date().toISOString();
  const from = query.from;

  if (from !== undefined) requireInstant(from, 'from');
  requireInstant(to, 'to');
  if (from !== undefined && from > to) {
    throw new AuditFilterError('The start of the range must not be after its end.');
  }

  const eventType = query.eventType;
  if (eventType !== undefined && !isAuditEventType(eventType)) {
    throw new AuditFilterError(`Unknown event type "${eventType}".`);
  }

  const actorId = query.actorId;
  if (actorId !== undefined && !UUID.test(actorId)) {
    throw new AuditFilterError('The actor filter takes a member id.');
  }

  return {
    ...(from !== undefined ? { from } : {}),
    to,
    ...(eventType ? { eventType } : {}),
    ...(actorId ? { actorId } : {}),
  };
}

/**
 * The cursor a caller may resume from, checked before it can reach DynamoDB.
 *
 * A cursor is a client-supplied value that becomes an `ExclusiveStartKey`, and
 * every malformed shape lands as a `ValidationException` the error middleware
 * turns into a 500 — a server failure reported for a client mistake. Three ways
 * it can be wrong, all of them refused here as a 400:
 *
 * - Not base64url. Node's decoder is permissive rather than strict: `!` decodes
 *   to an empty buffer and `abc` to mojibake, so the round trip is the check.
 * - Not a sort key. The stored form is `{createdAt}#{eventId}`, and anything
 *   else either sorts outside the range or is not a key at all.
 * - Outside the window. DynamoDB refuses a start key beyond the range its own
 *   key condition names, which is what a cursor kept across a filter change is.
 *
 * Returns the cursor unchanged so the caller passes on what it was given; the
 * decode back into a key belongs to the read path that builds the query.
 */
export function parseAuditCursor(
  cursor: string | undefined,
  window: Pick<AuditWindow, 'from' | 'to'>,
): string | undefined {
  if (cursor === undefined) return undefined;

  const sortKey = Buffer.from(cursor, 'base64url').toString('utf8');
  if (Buffer.from(sortKey, 'utf8').toString('base64url') !== cursor) {
    throw new AuditFilterError(MALFORMED_CURSOR);
  }

  const separator = sortKey.indexOf('#');
  if (separator === -1 || separator === sortKey.length - 1) {
    throw new AuditFilterError(MALFORMED_CURSOR);
  }

  const createdAt = sortKey.slice(0, separator);
  const parsed = new Date(createdAt);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== createdAt) {
    throw new AuditFilterError(MALFORMED_CURSOR);
  }

  // Compared as strings, the way the sort key itself is: the bounds carry no
  // `#`, so a key at either instant still falls inside the range.
  if (sortKey < window.from || sortKey > window.to) {
    throw new AuditFilterError(
      'That page is outside the range being read. Clear the cursor and read the range again.',
    );
  }

  return cursor;
}

/** One message for every malformed shape: none of them is the caller's to fix. */
const MALFORMED_CURSOR = 'The page cursor is not valid. Read the range again from the start.';

/**
 * The canonical form `Date#toISOString` produces, which is what the sort key
 * holds. A parseable string that round-trips to something else — an offset, a
 * missing millisecond — would compare wrong against stored keys, so the check is
 * equality with the round trip rather than "does Date accept it".
 */
function requireInstant(value: string, field: string): void {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new AuditFilterError(
      `"${field}" must be an ISO-8601 UTC instant, for example 2026-08-01T00:00:00.000Z.`,
    );
  }
}
