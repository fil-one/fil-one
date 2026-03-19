import { describe, it, expect, vi, afterEach } from 'vitest';
import { daysUntil, expiresAtFromForm, formatDate, formatDateTime, timeAgo } from './time.js';

// ---------------------------------------------------------------------------
// daysUntil — UTC calendar-day math
// ---------------------------------------------------------------------------

describe('daysUntil', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 0 for a date in the past', () => {
    vi.useFakeTimers({ now: new Date('2026-03-15T12:00:00Z') });
    expect(daysUntil('2026-03-10T00:00:00Z')).toBe(0);
  });

  it('returns 0 when the target date is today (UTC)', () => {
    vi.useFakeTimers({ now: new Date('2026-03-15T10:00:00Z') });
    expect(daysUntil('2026-03-15T23:59:59Z')).toBe(0);
  });

  it('returns exact day count for a future date', () => {
    vi.useFakeTimers({ now: new Date('2026-03-01T00:00:00Z') });
    expect(daysUntil('2026-03-15T00:00:00Z')).toBe(14);
  });

  it('is stable regardless of time-of-day (early morning)', () => {
    vi.useFakeTimers({ now: new Date('2026-03-12T01:00:00Z') });
    expect(daysUntil('2026-03-27T00:00:00Z')).toBe(15);
  });

  it('is stable regardless of time-of-day (late evening)', () => {
    vi.useFakeTimers({ now: new Date('2026-03-12T23:59:59Z') });
    expect(daysUntil('2026-03-27T00:00:00Z')).toBe(15);
  });

  it('both components would show the same number (the original bug)', () => {
    // Simulate two calls moments apart — both should return the same value
    vi.useFakeTimers({ now: new Date('2026-03-12T23:59:59.500Z') });
    const first = daysUntil('2026-03-27T00:00:00Z');

    // Advance 1 second (crossing into 2026-03-13 UTC)
    vi.setSystemTime(new Date('2026-03-13T00:00:00.500Z'));
    const second = daysUntil('2026-03-27T00:00:00Z');

    // They differ by exactly 1 because the UTC date changed — but within
    // a single render cycle (same UTC date) they will always match.
    expect(first).toBe(15);
    expect(second).toBe(14);
  });

  it('returns 1 for tomorrow', () => {
    vi.useFakeTimers({ now: new Date('2026-03-14T18:00:00Z') });
    expect(daysUntil('2026-03-15T00:00:00Z')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// formatDate — locale-aware date
// ---------------------------------------------------------------------------

describe('formatDate', () => {
  it('returns a non-empty string for a valid ISO date', () => {
    const result = formatDate('2026-03-15T00:00:00Z');
    expect(result).toBeTruthy();
    // Should contain "2026" somewhere (year)
    expect(result).toContain('2026');
  });

  it('includes the day of the month', () => {
    // Use midday UTC so local timezone offset doesn't shift the calendar date
    const result = formatDate('2026-03-15T12:00:00Z');
    expect(result).toContain('15');
  });
});

// ---------------------------------------------------------------------------
// formatDateTime — locale-aware date + time
// ---------------------------------------------------------------------------

describe('formatDateTime', () => {
  it('returns a non-empty string containing the year', () => {
    const result = formatDateTime('2026-03-15T14:30:00Z');
    expect(result).toBeTruthy();
    expect(result).toContain('2026');
  });

  it('includes a time component', () => {
    const result = formatDateTime('2026-03-15T14:30:00Z');
    // Should contain "30" from the minutes at minimum
    expect(result).toContain('30');
  });
});

// ---------------------------------------------------------------------------
// timeAgo — relative time labels
// ---------------------------------------------------------------------------

describe('timeAgo', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows minutes for < 1 hour', () => {
    vi.useFakeTimers({ now: new Date('2026-03-15T12:30:00Z') });
    expect(timeAgo('2026-03-15T12:05:00Z')).toBe('25m ago');
  });

  it('shows 0m ago for just now', () => {
    vi.useFakeTimers({ now: new Date('2026-03-15T12:00:00Z') });
    expect(timeAgo('2026-03-15T12:00:00Z')).toBe('0m ago');
  });

  it('shows hours for < 24 hours', () => {
    vi.useFakeTimers({ now: new Date('2026-03-15T18:00:00Z') });
    expect(timeAgo('2026-03-15T12:00:00Z')).toBe('6h ago');
  });

  it('shows days for >= 24 hours', () => {
    vi.useFakeTimers({ now: new Date('2026-03-18T12:00:00Z') });
    expect(timeAgo('2026-03-15T12:00:00Z')).toBe('3d ago');
  });
});

// ---------------------------------------------------------------------------
// expiresAtFromForm — form expiration to YYYY-MM-DD
// ---------------------------------------------------------------------------

describe('expiresAtFromForm', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for "never"', () => {
    expect(expiresAtFromForm('never', null)).toBeNull();
  });

  it('returns null for "never" even when customDate is set', () => {
    expect(expiresAtFromForm('never', '2026-05-01')).toBeNull();
  });

  it('returns YYYY-MM-DD 30 days from now for "30d"', () => {
    vi.useFakeTimers({ now: new Date('2026-03-01T12:00:00Z') });
    expect(expiresAtFromForm('30d', null)).toBe('2026-03-31');
  });

  it('uses UTC so result is correct near midnight UTC', () => {
    // 2026-03-01T23:30:00Z — local time in UTC+2 would be 2026-03-02 01:30
    // but UTC date is still March 1, so +30 should be March 31
    vi.useFakeTimers({ now: new Date('2026-03-01T23:30:00Z') });
    expect(expiresAtFromForm('30d', null)).toBe('2026-03-31');
  });

  it('handles month rollover correctly', () => {
    vi.useFakeTimers({ now: new Date('2026-01-15T10:00:00Z') });
    expect(expiresAtFromForm('30d', null)).toBe('2026-02-14');
  });

  it('handles year rollover correctly', () => {
    vi.useFakeTimers({ now: new Date('2026-12-10T10:00:00Z') });
    expect(expiresAtFromForm('30d', null)).toBe('2027-01-09');
  });

  it('returns customDate for "custom"', () => {
    expect(expiresAtFromForm('custom', '2026-06-15')).toBe('2026-06-15');
  });

  it('returns null for "custom" when customDate is null', () => {
    expect(expiresAtFromForm('custom', null)).toBeNull();
  });
});
