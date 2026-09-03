import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AUDIT_RETENTION_DAYS } from '@filone/shared';
import { AuditFilterError, parseAuditRequest } from './audit-request.js';

const NOW = '2026-08-15T12:00:00.000Z';
const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const FROM = '2026-08-01T00:00:00.000Z';

const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64url');

/** The oldest instant retention holds at {@link NOW}. */
const retentionFloor = new Date(
  Date.parse(NOW) - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
).toISOString();

describe('parseAuditRequest', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => vi.useRealTimers());

  // Left for resolveWindow to fill, so the retention boundary lives in one place
  // and "asked for everything" stays distinguishable from "asked for more than
  // exists".
  it('leaves an absent lower bound absent, and takes now as the upper one', () => {
    expect(parseAuditRequest({})).toEqual({ filters: { to: NOW } });
  });

  it('takes the range it was given', () => {
    expect(parseAuditRequest({ from: FROM, to: '2026-08-02T00:00:00.000Z' })).toEqual({
      filters: { from: FROM, to: '2026-08-02T00:00:00.000Z' },
    });
  });

  // A date-only bound would compare against `2026-08-01T09:14:22.104Z#…` and
  // quietly drop everything on the closing day, an offset would compare wrong
  // against every stored key, and a calendar date that does not exist is not a
  // bound at all. The console widens a picked date, where it knows which end.
  it.each([
    ['2026-08-01'],
    ['2026-08-01T00:00:00Z'],
    ['2026-08-01T00:00:00+02:00'],
    ['2026-08-01T00:00:00.000+02:00'],
    ['2026-02-30T00:00:00.000Z'],
    ['nonsense'],
  ])('refuses %j as a bound', (from) => {
    expect(() => parseAuditRequest({ from })).toThrow(AuditFilterError);
  });

  it('names the field whose bound was refused', () => {
    expect(() => parseAuditRequest({ from: '2026-08-01' })).toThrow('"from" must be an ISO-8601');
    expect(() => parseAuditRequest({ to: '2026-08-01' })).toThrow('"to" must be an ISO-8601');
  });

  it('refuses a range that runs backwards', () => {
    expect(() => parseAuditRequest({ from: '2026-08-02T00:00:00.000Z', to: FROM })).toThrow(
      'must not be after its end',
    );
  });

  it('takes a known event type', () => {
    expect(parseAuditRequest({ eventType: 'member.removed' }).filters.eventType).toBe(
      'member.removed',
    );
  });

  it('refuses an event type the registry does not name', () => {
    expect(() => parseAuditRequest({ eventType: 'org.deleted' })).toThrow(
      'Unknown event type "org.deleted".',
    );
  });

  it('takes a member id as the actor', () => {
    expect(parseAuditRequest({ actorId: USER_ID }).filters.actorId).toBe(USER_ID);
  });

  // The filter matches actor.id, so an address here would match nothing and read
  // as an empty history rather than as a rejected filter.
  it('refuses an email as the actor', () => {
    expect(() => parseAuditRequest({ actorId: 'owner@example.com' })).toThrow('takes a member id');
  });

  // Ids are minted by crypto.randomUUID(), but the shape is the check: refusing
  // an id whose version nibble disagrees with v4 would refuse one this system
  // has already stored.
  it('accepts a stored id that is not a v4 UUID', () => {
    const legacy = '11111111-2222-3333-4444-555555555555';

    expect(parseAuditRequest({ actorId: legacy }).filters.actorId).toBe(legacy);
  });

  it('leaves an absent filter off rather than passing undefined through', () => {
    expect(parseAuditRequest({}).filters).not.toHaveProperty('eventType');
    expect(parseAuditRequest({}).filters).not.toHaveProperty('actorId');
    expect(parseAuditRequest({})).not.toHaveProperty('cursor');
  });

  describe('the cursor', () => {
    it('comes back unchanged when it names a page inside the window', () => {
      const cursor = encode('2026-08-10T00:00:00.000Z#evt-1');

      expect(parseAuditRequest({ from: FROM, cursor })).toEqual({
        filters: { from: FROM, to: NOW },
        cursor,
      });
    });

    it('is accepted sitting exactly on a bound', () => {
      // The bounds carry no `#`, so a key stamped at the instant still sorts in.
      expect(() =>
        parseAuditRequest({ from: FROM, cursor: encode(`${FROM}#evt-1`) }),
      ).not.toThrow();
    });

    it('is resumable against the default window', () => {
      expect(() => parseAuditRequest({ cursor: encode(`${retentionFloor}#evt-1`) })).not.toThrow();
    });

    // The alphabet check the schema owns.
    it.each([['!'], ['!!!'], ['a+b/c=']])('refuses %j, which is not base64url', (cursor) => {
      expect(() => parseAuditRequest({ cursor })).toThrow('cursor is not valid');
    });

    // Node's base64url decoder is permissive where the alphabet check is not:
    // both of these are valid base64url and decode to something that is not a
    // sort key, which DynamoDB would answer with a 500.
    it.each([[''], ['abc']])('refuses %j, which decodes to no sort key', (cursor) => {
      expect(() => parseAuditRequest({ cursor })).toThrow('cursor is not valid');
    });

    it.each([
      ['2026-08-10T00:00:00.000Z'],
      ['2026-08-10T00:00:00.000Z#'],
      ['#evt-1'],
      ['2026-08-10#evt-1'],
      ['not-a-date#evt-1'],
    ])('refuses a cursor decoding to %j, which is not a sort key', (sortKey) => {
      expect(() => parseAuditRequest({ from: FROM, cursor: encode(sortKey) })).toThrow(
        'cursor is not valid',
      );
    });

    // What a cursor kept across a filter change looks like. DynamoDB refuses a
    // start key beyond the range its own key condition names.
    it.each([['2026-07-01T00:00:00.000Z#evt-1'], ['2026-09-01T00:00:00.000Z#evt-1']])(
      'refuses %j, which is outside the window',
      (sortKey) => {
        expect(() => parseAuditRequest({ from: FROM, cursor: encode(sortKey) })).toThrow(
          'outside the range being read',
        );
      },
    );
  });
});
