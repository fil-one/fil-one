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

/** Pluralized day count, e.g. "1 day", "3 days". */
export function pluralizeDays(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/**
 * Countdown phrase for banners, e.g. "3 days remaining".
 *
 * `daysUntil` clamps to >= 0, so 0 means the deadline falls later today rather
 * than "no time left"; it gets its own wording instead of "0 days remaining".
 */
export function daysRemainingLabel(days: number): string {
  if (days === 0) return 'Less than a day remaining';
  return `${pluralizeDays(days)} remaining`;
}

// ---------------------------------------------------------------------------
// Locale-aware display
// ---------------------------------------------------------------------------

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const dateShortFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

const timeShortFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

const monthDayFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

/**
 * Month and day, e.g. "Aug 15" — for the near end of a range whose year is
 * stated once, at the far end.
 */
export function formatMonthDay(isoString: string): string {
  return monthDayFormatter.format(new Date(isoString));
}

/** Locale-aware date string, e.g. "Mar 27, 2026". */
export function formatDate(isoString: string): string {
  return dateFormatter.format(new Date(isoString));
}

/**
 * Locale-aware date without the year, e.g. "Mar 27".
 *
 * For chart axes, where every tick in a 7- or 30-day window repeats the same
 * year and mostly the same month. Pair it with `formatDate` in the tooltip,
 * which is where the unambiguous date belongs.
 */
export function formatDateShort(isoString: string): string {
  return dateShortFormatter.format(new Date(isoString));
}

/**
 * Locale-aware hour, e.g. "7 PM" or "19" depending on locale.
 *
 * For the 24-hour chart axis, where the date is the same on every tick and the
 * hour is the only part that varies. The tooltip carries the full timestamp.
 */
export function formatTimeShort(isoString: string): string {
  return timeShortFormatter.format(new Date(isoString));
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

// ---------------------------------------------------------------------------
// Form helpers
// ---------------------------------------------------------------------------

import type { ExpirationOption } from '../components/AccessKeyExpirationFields.js';

/**
 * Convert form expiration fields to a YYYY-MM-DD string (or null).
 * Uses UTC arithmetic so the result is consistent with toISOString().
 */
export function expiresAtFromForm(
  expiration: ExpirationOption,
  customDate: string | null,
): string | null {
  if (expiration === 'never') return null;
  if (expiration === '30d') {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 30);
    return d.toISOString().split('T')[0]; // YYYY-MM-DD
  }
  return customDate ?? null; // date input already yields YYYY-MM-DD
}
