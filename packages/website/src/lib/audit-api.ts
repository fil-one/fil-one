import type { AuditEventType, ListAuditEventsResponse } from '@filone/shared';
import { apiDownload, apiRequest } from './api.js';

/**
 * The audit log viewer's two calls.
 *
 * Filters are held as picked dates and turned into instants here, because the
 * sort key is a lexicographic ISO string and a date-only bound would compare
 * against `2026-08-01T09:14:22.104Z#...`. Widening in the console is what lets
 * the backend refuse an ambiguous bound outright.
 */

/** What the filter bar holds: dates as the picker gives them, `YYYY-MM-DD`. */
export interface AuditFilterState {
  from: string;
  to: string;
  eventType: AuditEventType | '';
  actorId: string;
}

/** Nothing filtered: the backend's own default window, and every event. */
export const EMPTY_AUDIT_FILTERS: AuditFilterState = {
  from: '',
  to: '',
  eventType: '',
  actorId: '',
};

export function hasAuditFilters(filters: AuditFilterState): boolean {
  return Boolean(filters.from || filters.to || filters.eventType || filters.actorId);
}

/**
 * The query string both calls share.
 *
 * `from` widens to the first instant of its day and `to` to the first instant
 * of the day *after* the one picked, because the range's upper bound is
 * exclusive and a reader who picks the 5th means through the end of the 5th.
 *
 * An empty bound is left out rather than sent, so the backend fills it. Sending
 * the oldest instant retention holds would be indistinguishable from a caller
 * asking for more history than exists, and the console would then announce a
 * retention cut on every unfiltered page load.
 */
export function auditQueryParams(filters: AuditFilterState, cursor?: string): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', `${filters.from}T00:00:00.000Z`);
  if (filters.to) params.set('to', endOfDay(filters.to));
  if (filters.eventType) params.set('eventType', filters.eventType);
  if (filters.actorId) params.set('actorId', filters.actorId);
  if (cursor) params.set('cursor', cursor);
  return params;
}

/** The first instant after the day picked, since the upper bound is exclusive. */
function endOfDay(day: string): string {
  const next = new Date(`${day}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

export function listAuditEvents(
  filters: AuditFilterState,
  cursor?: string,
): Promise<ListAuditEventsResponse> {
  return apiRequest<ListAuditEventsResponse>(`/audit?${auditQueryParams(filters, cursor)}`);
}

export function downloadAuditCsv(filters: AuditFilterState): Promise<Blob> {
  return apiDownload(`/audit/export?${auditQueryParams(filters)}`);
}

/** Names the file by the window, so two exports are tellable apart. */
export function auditCsvFilename(filters: AuditFilterState): string {
  const suffix =
    filters.from || filters.to ? `-${filters.from || 'start'}-to-${filters.to || 'now'}` : '';
  return `audit-log${suffix}.csv`;
}
