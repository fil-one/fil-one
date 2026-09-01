import type { AuditEvent, AuditEventType } from '../audit.js';

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
 * The filters both routes take, as the handler reads them off the query string.
 *
 * `from` and `to` are ISO-8601 UTC instants, `from` inclusive and `to`
 * exclusive. The sort key is a lexicographic ISO string, so a date the user
 * picked has to be widened to an instant before it reaches DynamoDB; the
 * console does that when it builds the request.
 *
 * The org is never here. Both routes scope to the org resolved from the
 * caller's membership, so an org id in the query string could only be an
 * attempt to read someone else's history.
 */
export interface AuditQueryFilters {
  /**
   * Absent when the caller named no lower bound, which is not the same as
   * naming the oldest instant retention holds: a caller who asked for
   * everything has not asked for more than exists, and their window is not
   * reported as clamped.
   */
  from?: string;
  to: string;
  /**
   * One type, or none for all of them. One rather than several because the
   * index answers a single-type query and a multi-type query would be one index
   * read plus a filter for the rest.
   */
  eventType?: AuditEventType;
  /**
   * A member's `userId`, matched exactly against `actor.id`.
   *
   * Never an address. An id survives an address change, so a member who changes
   * email keeps one history, and it stays distinct when an address is reused —
   * someone re-invited at an old address gets a new id, and matching on email
   * would merge two people's histories into one result.
   */
  actorId?: string;
}

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
   * Present only when the page filled before the window ran out. Its absence
   * means the end of the history, not the end of a page.
   */
  nextCursor?: string;
}
