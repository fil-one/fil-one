import { describe, it, expect } from 'vitest';
import {
  auditCsvFilename,
  auditQueryParams,
  EMPTY_AUDIT_FILTERS,
  hasAuditFilters,
} from './audit-api.js';

const params = (overrides: Partial<typeof EMPTY_AUDIT_FILTERS> = {}) =>
  Object.fromEntries(auditQueryParams({ ...EMPTY_AUDIT_FILTERS, ...overrides }));

describe('auditQueryParams', () => {
  // Sending the oldest instant retention holds would be indistinguishable from
  // asking for more history than exists, and the console would then announce a
  // retention cut on every unfiltered page load.
  it('sends nothing when nothing is filtered', () => {
    expect(params()).toEqual({});
  });

  it('widens the lower bound to the first instant of its day', () => {
    expect(params({ from: '2026-08-01' }).from).toBe('2026-08-01T00:00:00.000Z');
  });

  // The upper bound is exclusive, and a reader who picks the 5th means through
  // the end of the 5th.
  it('widens the upper bound past the end of its day', () => {
    expect(params({ to: '2026-08-05' }).to).toBe('2026-08-06T00:00:00.000Z');
  });

  it('rolls the upper bound over a month end', () => {
    expect(params({ to: '2026-08-31' }).to).toBe('2026-09-01T00:00:00.000Z');
  });

  it('carries the event type, the actor, and a cursor', () => {
    const query = Object.fromEntries(
      auditQueryParams(
        { ...EMPTY_AUDIT_FILTERS, eventType: 'key.deleted', actorId: 'user-1' },
        'cursor-1',
      ),
    );

    expect(query).toEqual({ eventType: 'key.deleted', actorId: 'user-1', cursor: 'cursor-1' });
  });
});

describe('hasAuditFilters', () => {
  it('is false for the empty filter state', () => {
    expect(hasAuditFilters(EMPTY_AUDIT_FILTERS)).toBe(false);
  });

  it.each([
    [{ from: '2026-08-01' }],
    [{ to: '2026-08-05' }],
    [{ eventType: 'key.deleted' as const }],
    [{ actorId: 'user-1' }],
  ])('is true once %o is set', (patch) => {
    expect(hasAuditFilters({ ...EMPTY_AUDIT_FILTERS, ...patch })).toBe(true);
  });
});

describe('auditCsvFilename', () => {
  it('names an unfiltered export plainly', () => {
    expect(auditCsvFilename(EMPTY_AUDIT_FILTERS)).toBe('audit-log.csv');
  });

  // Two exports in a downloads folder have to be tellable apart.
  it('names the window when one was picked', () => {
    expect(auditCsvFilename({ ...EMPTY_AUDIT_FILTERS, from: '2026-08-01', to: '2026-08-05' })).toBe(
      'audit-log-2026-08-01-to-2026-08-05.csv',
    );
  });

  it('names an open-ended window without leaving a gap', () => {
    expect(auditCsvFilename({ ...EMPTY_AUDIT_FILTERS, from: '2026-08-01' })).toBe(
      'audit-log-2026-08-01-to-now.csv',
    );
  });
});
