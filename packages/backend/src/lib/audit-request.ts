import { AuditQuerySchema, MALFORMED_CURSOR } from '@filone/shared';
import type { AuditQueryFilters } from '@filone/shared';
import { resolveWindow } from './audit-query.js';

/** What both audit routes accept, and the one place a request is checked. */

/** A caller asked for something the query cannot be built from. */
export class AuditFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditFilterError';
  }
}

export interface AuditRequest {
  filters: AuditQueryFilters;
  /** Where to resume, absent on a first page. */
  cursor?: string;
}

/**
 * The query string as a read the handler can perform, or a refusal saying why
 * it is not one.
 *
 * `AuditQuerySchema` owns everything expressible about the raw parameters: the
 * bounds in the exact form the sort key holds, the event type against the closed
 * union, the actor as an id rather than an address, the cursor's alphabet, and
 * the range running forwards. What it cannot own is the half that needs the
 * cursor decoded, because decoding needs `Buffer` and that schema is bundled for
 * the browser too. Those checks are below.
 *
 * Throws {@link AuditFilterError} rather than returning a result, so both
 * handlers keep one catch that answers 400.
 */
export function parseAuditRequest(query: Record<string, string | undefined>): AuditRequest {
  const parsed = AuditQuerySchema.safeParse(query);
  if (!parsed.success) {
    // The schema's own first issue, which is the field-level message rather
    // than a generic "invalid request" — the same choice `parseJsonBody` makes.
    throw new AuditFilterError(parsed.error.issues[0].message);
  }

  const { cursor, ...filters } = parsed.data;
  if (cursor === undefined) return { filters };

  requireResumableCursor(cursor, filters);
  return { filters, cursor };
}

/**
 * The half of a cursor's validity that only the read path can judge.
 *
 * A cursor becomes an `ExclusiveStartKey`, and DynamoDB answers a malformed or
 * out-of-range one with a `ValidationException` the error middleware reports as
 * a 500 — a server failure for a caller's mistake. Two ways it can still be
 * wrong once the alphabet checks out:
 *
 * - It does not decode to a sort key. Node's base64url decoder is permissive
 *   where the alphabet check is not: an empty string and a short run of letters
 *   both decode to something that is not `{createdAt}#{eventId}`.
 * - It points outside the window being read, which is what a cursor kept across
 *   a filter change is. DynamoDB refuses a start key beyond the range its own
 *   key condition names.
 */
function requireResumableCursor(cursor: string, filters: AuditQueryFilters): void {
  const sortKey = Buffer.from(cursor, 'base64url').toString('utf8');

  const separator = sortKey.indexOf('#');
  if (separator === -1 || separator === sortKey.length - 1) {
    throw new AuditFilterError(MALFORMED_CURSOR);
  }

  // The leading half is a stored `createdAt`, so it is held to the same form the
  // bounds are. Parsed through the schema's own bound so the two cannot drift.
  const createdAt = AuditQuerySchema.safeParse({ to: sortKey.slice(0, separator) });
  if (!createdAt.success) throw new AuditFilterError(MALFORMED_CURSOR);

  // Compared as strings, the way the sort key itself is: the bounds carry no
  // `#`, so a key stamped at either instant still falls inside the range.
  const window = resolveWindow(filters);
  if (sortKey < window.from || sortKey > window.to) {
    throw new AuditFilterError(
      'That page is outside the range being read. Clear the cursor and read the range again.',
    );
  }
}
