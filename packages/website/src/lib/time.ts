/**
 * Shared date/time utilities.
 *
 * - Countdown helpers (`daysUntil`) use UTC calendar-day math so the number
 *   matches the backend's UTC-based expiry.
 * - Display helpers (`formatDate`, `formatDateTime`, `timeAgo`) use the
 *   browser's locale so timestamps feel natural to the user.
 */

// ---------------------------------------------------------------------------
// Countdown — UTC calendar-day difference
// ---------------------------------------------------------------------------

/** Days remaining until an ISO-8601 timestamp, based on UTC calendar dates. */
export function daysUntil(isoString: string): number {
  const now = new Date();
  const end = new Date(isoString);
  const nowUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const endUTC = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.max(0, Math.round((endUTC - nowUTC) / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Locale-aware display
// ---------------------------------------------------------------------------

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

/** Locale-aware date string, e.g. "Mar 27, 2026". */
export function formatDate(isoString: string): string {
  return dateFormatter.format(new Date(isoString));
}

/** Locale-aware date + time string, e.g. "Mar 27, 2026, 7:00 PM EDT". */
export function formatDateTime(isoString: string): string {
  return dateTimeFormatter.format(new Date(isoString));
}

// ---------------------------------------------------------------------------
// Relative time — for activity feeds
// ---------------------------------------------------------------------------

/** Short relative label, e.g. "5m ago", "3h ago", "2d ago". */
export function timeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
