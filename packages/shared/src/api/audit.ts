import { z } from 'zod';
import { AUDIT_EVENT_TYPES } from '../audit.ts';
import type { AuditEvent } from '../audit.ts';

/**
 * The audit log read API: what the viewer asks for and what it gets back.
 *
 * The stored envelope lives in `../audit.ts` and is the contract between the
 * write path and this one. What is here is only the request and response
 * around it.
 */

/**
 * Events per page.
 *
 * The handler fills a page before answering, so this is a count of matched
 * events rather than of items read — a filtered Query can scan a megabyte and
 * match none of it.
 */
export const AUDIT_PAGE_SIZE = 50;

/**
 * Rows one export may carry.
 *
 * The binding constraint is Lambda's 6MB synchronous response, which at roughly
 * 300 bytes a row lands near here. Exceeding it is refused rather than
 * truncated: a short audit export that does not say it is short is the worst
 * failure this feature has.
 */
export const AUDIT_EXPORT_MAX_ROWS = 20_000;

/**
 * Bytes one export may carry, under Lambda's 6MB limit with room for the
 * response envelope and base64 growth in transit.
 *
 * The row cap is the honest limit and this is the backstop, for a run of events
 * whose `details` are larger than the estimate the row cap was drawn from.
 */
export const AUDIT_EXPORT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * A bound, in the exact form the sort key holds.
 *
 * `precision: 3` with no offset allowed is precisely what `toISOString()`
 * produces, which is what `createdAt` is stored as. The strictness is the point:
 * a date-only bound would compare against `2026-08-01T09:14:22.104Z#…` and
 * quietly exclude the closing day, and an offset would compare wrong against
 * every stored key. The console widens a picked date into an instant, where it
 * knows which end it is widening.
 */
const auditInstant = (field: 'from' | 'to') =>
  z.iso.datetime({
    precision: 3,
    message: `"${field}" must be an ISO-8601 UTC instant, for example 2026-08-01T00:00:00.000Z.`,
  });

/** Every malformed cursor reads the same: none of them is the caller's to fix. */
export const MALFORMED_CURSOR =
  'The page cursor is not valid. Read the range again from the start.';

/**
 * What both routes accept on the query string.
 *
 * The org is never here. Both routes scope to the org resolved from the caller's
 * membership, so an org id in the query string could only be an attempt to read
 * someone else's history.
 *
 * What this cannot check is the half that needs the cursor decoded — that it
 * carries a sort key, and that the key falls inside the window being read.
 * Decoding needs `Buffer`, this package is bundled for the browser as well, and
 * a cursor is server-only in any case: the console returns whichever one the API
 * handed it. Those two checks live with the read path.
 */
export const AuditQuerySchema = z
  .object({
    /**
     * Absent when the caller named no lower bound, which is not the same as
     * naming the oldest instant retention holds: a caller who asked for
     * everything has not asked for more than exists, and their window is not
     * reported as clamped.
     */
    from: auditInstant('from').optional(),
    /** Now, when the caller named no upper bound. */
    to: auditInstant('to').default(() => new Date().toISOString()),
    /**
     * One type, or none for all of them. One rather than several because the
     * index answers a single-type query and a multi-type query would be one
     * index read plus a filter for the rest.
     */
    eventType: z
      .enum(AUDIT_EVENT_TYPES, {
        // Names the type it was given: a caller who mistyped one needs to see
        // which, and the registry is closed so there is nothing to leak.
        error: (issue) => `Unknown event type "${String(issue.input)}".`,
      })
      .optional(),
    /**
     * A member's `userId`, matched exactly against `actor.id`.
     *
     * Never an address. An id survives an address change, so a member who
     * changes email keeps one history, and it stays distinct when an address is
     * reused — someone re-invited at an old address gets a new id, and matching
     * on email would merge two people's histories into one result.
     *
     * `guid` rather than `uuid`: the shape is the check. Ids are minted by
     * `crypto.randomUUID()`, but refusing anything whose version and variant
     * nibbles disagree with v4 would refuse an id this system stored.
     */
    actorId: z.guid({ message: 'The actor filter takes a member id.' }).optional(),
    /** Opaque to the caller, and checked further by the read path. */
    cursor: z.base64url({ message: MALFORMED_CURSOR }).optional(),
  })
  .refine((query) => query.from === undefined || query.from <= query.to, {
    message: 'The start of the range must not be after its end.',
    path: ['from'],
  });

export type AuditQueryRequest = z.infer<typeof AuditQuerySchema>;

/**
 * The filters a read is performed with — the request without its cursor.
 *
 * `from` inclusive, `to` exclusive.
 */
export type AuditQueryFilters = Omit<AuditQueryRequest, 'cursor'>;

/**
 * The window a request was actually served over.
 *
 * Returned because a request reaching past retention is clamped, and handing
 * back a quarter to someone who asked for half a year without saying so reads
 * as data loss.
 */
export interface AuditWindow {
  from: string;
  to: string;
  /** The request asked for more than retention holds. */
  clamped: boolean;
}

export interface ListAuditEventsResponse {
  events: AuditEvent[];
  window: AuditWindow;
  /**
   * Where the next page resumes, present only when a further matching event was
   * actually found. So following a cursor always yields at least one event, and
   * its absence is the end of the history rather than the end of a page.
   */
  nextCursor?: string;
}
