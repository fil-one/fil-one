import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AuditFilterError, parseAuditFilters } from './audit-request.js';

const NOW = '2026-08-15T12:00:00.000Z';
const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('parseAuditFilters', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => vi.useRealTimers());

  // Left for resolveWindow to fill, so the retention boundary lives in one place
  // and "asked for everything" stays distinguishable from "asked for more than
  // exists".
  it('leaves an absent lower bound absent, and takes now as the upper one', () => {
    expect(parseAuditFilters({})).toEqual({ to: NOW });
  });

  it('takes the range it was given', () => {
    expect(
      parseAuditFilters({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' }),
    ).toEqual({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' });
  });

  // A date-only bound would compare against `2026-08-01T09:14:22.104Z#...` and
  // quietly drop everything on the closing day, so it is refused rather than
  // widened here — the console widens it, where it knows which end it is.
  it.each([['2026-08-01'], ['2026-08-01T00:00:00Z'], ['2026-08-01T00:00:00+02:00'], ['nonsense']])(
    'refuses %j as a bound',
    (from) => {
      expect(() => parseAuditFilters({ from })).toThrow(AuditFilterError);
    },
  );

  it('refuses a range that runs backwards', () => {
    expect(() =>
      parseAuditFilters({ from: '2026-08-02T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' }),
    ).toThrow(AuditFilterError);
  });

  it('takes a known event type', () => {
    expect(parseAuditFilters({ eventType: 'member.removed' }).eventType).toBe('member.removed');
  });

  it('refuses an event type the registry does not name', () => {
    expect(() => parseAuditFilters({ eventType: 'org.deleted' })).toThrow(
      'Unknown event type "org.deleted".',
    );
  });

  it('takes a member id as the actor', () => {
    expect(parseAuditFilters({ actorId: USER_ID }).actorId).toBe(USER_ID);
  });

  // The filter matches actor.id, so an address here would match nothing and read
  // as an empty history rather than as a rejected filter.
  it('refuses an email as the actor', () => {
    expect(() => parseAuditFilters({ actorId: 'owner@example.com' })).toThrow(
      'The actor filter takes a member id.',
    );
  });

  it('leaves an absent filter off rather than passing undefined through', () => {
    expect(parseAuditFilters({})).not.toHaveProperty('eventType');
    expect(parseAuditFilters({})).not.toHaveProperty('actorId');
  });
});
