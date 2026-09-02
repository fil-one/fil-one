import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AuditFilterError, parseAuditCursor, parseAuditFilters } from './audit-request.js';

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

describe('parseAuditCursor', () => {
  const WINDOW = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-15T12:00:00.000Z' };
  const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64url');

  it('passes an absent cursor through', () => {
    expect(parseAuditCursor(undefined, WINDOW)).toBeUndefined();
  });

  it('accepts a cursor inside the window and returns it unchanged', () => {
    const cursor = encode('2026-08-10T00:00:00.000Z#evt-1');

    expect(parseAuditCursor(cursor, WINDOW)).toBe(cursor);
  });

  it('accepts a cursor sitting exactly on a bound', () => {
    // The bounds carry no `#`, so a key stamped at the instant still sorts in.
    expect(() => parseAuditCursor(encode(`${WINDOW.from}#evt-1`), WINDOW)).not.toThrow();
  });

  // Node's base64url decoder is permissive: `!` yields an empty buffer and `abc`
  // yields mojibake, either of which reaches DynamoDB as an invalid start key
  // and comes back as a 500.
  it.each([['!'], ['!!!'], ['abc'], ['']])('refuses %j, which is not a cursor', (cursor) => {
    expect(() => parseAuditCursor(cursor, WINDOW)).toThrow(AuditFilterError);
  });

  it.each([
    ['2026-08-10T00:00:00.000Z'],
    ['2026-08-10T00:00:00.000Z#'],
    ['#evt-1'],
    ['2026-08-10#evt-1'],
    ['not-a-date#evt-1'],
  ])('refuses %j, which is not a sort key', (sortKey) => {
    expect(() => parseAuditCursor(encode(sortKey), WINDOW)).toThrow(AuditFilterError);
  });

  // What a cursor kept across a filter change looks like. DynamoDB refuses a
  // start key beyond the range its own key condition names.
  it.each([['2026-07-01T00:00:00.000Z#evt-1'], ['2026-09-01T00:00:00.000Z#evt-1']])(
    'refuses %j, which is outside the window',
    (sortKey) => {
      expect(() => parseAuditCursor(encode(sortKey), WINDOW)).toThrow(
        'outside the range being read',
      );
    },
  );
});
