import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AUDIT_RETENTION_DAYS, OrgRole } from '@filone/shared';
import type { AuditEvent, AuditEventType } from '@filone/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockQueryActivityEvents = vi.fn();
vi.mock('../lib/audit-query.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/audit-query.ts')>()),
  queryActivityEvents: (...args: unknown[]) => mockQueryActivityEvents(...args),
}));

const mockReportAuditQuery = vi.fn();
vi.mock('../lib/audit-metrics.ts', () => ({
  reportAuditQuery: (...args: unknown[]) => mockReportAuditQuery(...args),
}));

import { baseHandler } from './get-activity.ts';
import { buildEvent, membershipFor } from '../test/lambda-test-utilities.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'any-user', orgId: 'any-org' };

/** A succeeded completion, as the audit query hands it back. */
function auditEvent(
  type: AuditEventType,
  details: Record<string, unknown>,
  eventId = 'any-event',
): AuditEvent {
  return {
    eventId,
    type,
    actor: { kind: 'user', id: 'any-user' },
    orgId: USER_INFO.orgId,
    subject: 'org:any-org',
    details,
    createdAt: '2026-10-01T00:00:00.000Z',
    ttl: 1_800_000_000,
    phase: 'completion',
    correlationId: 'any-correlation',
    outcome: 'succeeded',
    // Each caller passes a payload that matches its type, a pairing TypeScript
    // cannot check when `type` is any member of the union.
  } as unknown as AuditEvent;
}

function resolveEvents(...events: AuditEvent[]) {
  mockQueryActivityEvents.mockResolvedValue({ events, cost: { pages: 1, rows: events.length } });
}

async function getActivities(queryStringParameters?: Record<string, string>) {
  const result = await baseHandler(buildEvent({ userInfo: USER_INFO, queryStringParameters }));
  return { statusCode: result.statusCode, body: JSON.parse(String(result.body)) };
}

function eventFor(role: OrgRole) {
  return buildEvent({
    userInfo: { ...USER_INFO, membership: membershipFor(USER_INFO.orgId, USER_INFO.userId, role) },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('get-activity baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveEvents();
  });

  it('returns no activities when the audit log holds no matching event', async () => {
    expect(await getActivities()).toStrictEqual({ statusCode: 200, body: { activities: [] } });
  });

  it.each(['bucket.created', 'bucket.deleted'] as const)(
    'renders a %s event as a bucket row named by the bucket',
    async (type) => {
      resolveEvents(auditEvent(type, { region: 'any-region', bucketName: 'any-bucket' }, 'e-1'));

      expect((await getActivities()).body).toStrictEqual({
        activities: [
          {
            id: 'e-1',
            action: type,
            resourceType: 'bucket',
            resourceName: 'any-bucket',
            timestamp: '2026-10-01T00:00:00.000Z',
          },
        ],
      });
    },
  );

  it.each(['key.created', 'key.rotated', 'key.deleted'] as const)(
    'renders a %s event as a key row named by the key',
    async (type) => {
      resolveEvents(auditEvent(type, { keyKind: 's3', keyName: 'any-key' }, 'e-1'));

      expect((await getActivities()).body).toStrictEqual({
        activities: [
          {
            id: 'e-1',
            action: type,
            resourceType: 'key',
            resourceName: 'any-key',
            timestamp: '2026-10-01T00:00:00.000Z',
          },
        ],
      });
    },
  );

  it('names a revoked key by its id suffix when the event recorded no name', async () => {
    resolveEvents(auditEvent('key.deleted', { keyKind: 's3', keyIdSuffix: 'WXYZ' }));

    expect((await getActivities()).body).toMatchObject({
      activities: [{ resourceName: '…WXYZ' }],
    });
  });

  it('drops an event type the feed does not render', async () => {
    resolveEvents(
      // The feed renders bucket and key events only.
      auditEvent('org.renamed', { name: 'any-name' }),
      auditEvent('bucket.created', { region: 'any-region', bucketName: 'any-bucket' }, 'e-2'),
    );

    expect((await getActivities()).body).toMatchObject({ activities: [{ id: 'e-2' }] });
  });

  it.each([
    ['the requested limit', { limit: '3' }, 3],
    ['10 when no limit is given', undefined, 10],
    ['10 when the limit is not a number', { limit: 'abc' }, 10],
    ['1 when the limit is negative', { limit: '-5' }, 1],
    ['50 when the limit is above 50', { limit: '100' }, 50],
  ])('asks the audit log for %s', async (_case, query, limit) => {
    await getActivities(query);

    expect(mockQueryActivityEvents).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: USER_INFO.orgId, limit }),
    );
  });

  describe('window', () => {
    const NOW = '2026-10-15T12:00:00.000Z';
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW));
    });
    afterEach(() => vi.useRealTimers());

    it('asks the audit log for the whole retention window up to now', async () => {
      await getActivities();

      const earliest = new Date(
        Date.parse(NOW) - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      expect(mockQueryActivityEvents).toHaveBeenCalledWith(
        expect.objectContaining({ from: earliest, to: NOW }),
      );
    });
  });

  it('cancels the read with the request deadline', async () => {
    const deadline = new AbortController().signal;

    await baseHandler(buildEvent({ userInfo: USER_INFO, requestContext: { deadline } }));

    expect(mockQueryActivityEvents).toHaveBeenCalledWith(
      expect.objectContaining({ signal: deadline }),
    );
  });

  it('reports the read under the activity route', async () => {
    resolveEvents(auditEvent('bucket.created', { region: 'any-region', bucketName: 'any-bucket' }));

    await getActivities();

    expect(mockReportAuditQuery).toHaveBeenCalledWith({
      route: 'activity',
      cost: { pages: 1, rows: 1 },
      durationMs: expect.any(Number),
      rowsReturned: 1,
    });
  });
});

describe('bucket activity follows the Buckets page scope', () => {
  // On a region with per-member access the Buckets page lists only the buckets
  // a Member's policy names, so the feed must not name the others.
  beforeEach(() => {
    vi.clearAllMocks();
    resolveEvents();
  });

  it.each([OrgRole.Owner, OrgRole.Admin])(
    'reads the whole org’s bucket events for %s',
    async (role) => {
      await baseHandler(eventFor(role));

      expect(mockQueryActivityEvents).toHaveBeenCalledWith(
        expect.objectContaining({ bucketEvents: { sees: 'all' } }),
      );
    },
  );

  it.each([OrgRole.Member, OrgRole.ReadOnly])(
    'reads only the bucket events %s acted on',
    async (role) => {
      await baseHandler(eventFor(role));

      expect(mockQueryActivityEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          bucketEvents: { sees: 'own', actorId: USER_INFO.userId },
        }),
      );
    },
  );
});

describe('key activity follows the keys pages scope', () => {
  // The route requirement is only half the gate: this feed carries key
  // lifecycle entries, and the dashboard must not show a caller keys the keys
  // page would refuse to list.
  beforeEach(() => {
    vi.clearAllMocks();
    resolveEvents();
  });

  it.each([OrgRole.Owner, OrgRole.Admin])(
    'reads the whole org’s key events for %s, holding keys.manage_all',
    async (role) => {
      await baseHandler(eventFor(role));

      expect(mockQueryActivityEvents).toHaveBeenCalledWith(
        expect.objectContaining({ keyEvents: { sees: 'all' } }),
      );
    },
  );

  it('reads only the key events a Member acted on', async () => {
    await baseHandler(eventFor(OrgRole.Member));

    expect(mockQueryActivityEvents).toHaveBeenCalledWith(
      expect.objectContaining({ keyEvents: { sees: 'own', actorId: USER_INFO.userId } }),
    );
  });

  it('reads no key events for ReadOnly, who holds no keys.* permission', async () => {
    await baseHandler(eventFor(OrgRole.ReadOnly));

    expect(mockQueryActivityEvents).toHaveBeenCalledWith(
      expect.objectContaining({ keyEvents: { sees: 'none' } }),
    );
  });
});
