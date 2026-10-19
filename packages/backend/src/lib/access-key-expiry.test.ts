import { describe, expect, it } from 'vitest';
import { toAccessKeyExpiryInstant } from './access-key-expiry.ts';
import { AccessKeyValidationError } from './errors.ts';

describe('toAccessKeyExpiryInstant', () => {
  it.each([
    ['2026-10-20', '2026-10-21T00:00:00.000Z'],
    // The next day crosses into the next month and year.
    ['2026-12-31', '2027-01-01T00:00:00.000Z'],
    // A leap day.
    ['2028-02-29', '2028-03-01T00:00:00.000Z'],
  ])('turns the bare date %s into the start of the next UTC day', (date, instant) => {
    expect(toAccessKeyExpiryInstant(date)).toBe(instant);
  });

  it('passes a timestamp through unchanged', () => {
    expect(toAccessKeyExpiryInstant('2027-01-01T12:30:00Z')).toBe('2027-01-01T12:30:00Z');
  });

  it.each([
    // A 13th month.
    '2026-13-01',
    // February has no 30th.
    '2026-02-30',
  ])('refuses the well-formed but impossible date %s as a validation error', (date) => {
    expect(() => toAccessKeyExpiryInstant(date)).toThrow(AccessKeyValidationError);
  });

  it.each([null, undefined, ''])('returns null for no expiry (%s)', (value) => {
    expect(toAccessKeyExpiryInstant(value)).toBeNull();
  });
});
