import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AUDIT_RETENTION_DAYS } from '@filone/shared';
import type { AuditEvent, AuditEventType } from '@filone/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockQueryRecentAuditEvents = vi.fn();
vi.mock('../lib/audit-query.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/audit-query.ts')>()),
  queryRecentAuditEvents: (...args: unknown[]) => mockQueryRecentAuditEvents(...args),
}));

const mockListBuckets = vi.fn();
const mockGetProvisionedNetworks = vi.fn();
vi.mock('../lib/region-helpers.ts', () => ({
  getProvisionedNetworks: (...args: unknown[]) => mockGetProvisionedNetworks(...args),
}));

/** The org's one network, whose buckets `mockListBuckets` lists. */
const ANY_NETWORK = {
  orchestrator: { id: 'any-orchestrator', regions: ['any-region'], listBuckets: mockListBuckets },
  tenantId: 'any-tenant',
};

const mockReportAuditQuery = vi.fn();
vi.mock('../lib/audit-metrics.ts', () => ({
  reportAuditQuery: (...args: unknown[]) => mockReportAuditQuery(...args),
}));

import { baseHandler } from './get-activity.ts';
import { buildEvent } from '../test/lambda-test-utilities.ts';

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
  mockQueryRecentAuditEvents.mockResolvedValue({ events, cost: { pages: 1, rows: events.length } });
}

/** A bucket as the storage system lists it; only the name, region and creation time matter here. */
function listedBucket(bucketName: string, createdAt: string, region = 'any-region') {
  return { bucketName, region, createdAt, isPublic: false, encrypted: false };
}

async function getActivities(queryStringParameters?: Record<string, string>) {
  const result = await baseHandler(buildEvent({ userInfo: USER_INFO, queryStringParameters }));
  return { statusCode: result.statusCode, body: JSON.parse(String(result.body)) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('get-activity baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveEvents();
    mockGetProvisionedNetworks.mockResolvedValue([ANY_NETWORK]);
    mockListBuckets.mockResolvedValue([]);
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

  it('asks the audit log for bucket and key events', async () => {
    await getActivities();

    expect(mockQueryRecentAuditEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        types: ['bucket.created', 'bucket.deleted', 'key.created', 'key.rotated', 'key.deleted'],
      }),
    );
  });

  const BUCKET = { region: 'any-region', bucketName: 'any-bucket' };
  it.each([
    ['an intent', { ...auditEvent('bucket.created', BUCKET), phase: 'intent', outcome: undefined }],
    ['a failed completion', { ...auditEvent('bucket.created', BUCKET), outcome: 'failed' }],
    [
      'an event for a Bucket Intelligence key',
      auditEvent('key.created', { keyKind: 'rag', keyName: 'any-key' }),
    ],
    [
      'the delete a rotation writes for the old credential',
      auditEvent('key.deleted', { keyKind: 's3', keyName: 'any-key', reason: 'rotation' }),
    ],
  ])('leaves out %s, and does not count it toward the read’s limit', async (_case, event) => {
    resolveEvents(event as AuditEvent);

    expect((await getActivities()).body).toStrictEqual({ activities: [] });
    const { isMatch } = mockQueryRecentAuditEvents.mock.calls[0][0];
    expect(isMatch(event)).toBe(false);
  });

  it('counts a succeeded S3 key event toward the read’s limit', async () => {
    await getActivities();

    const { isMatch } = mockQueryRecentAuditEvents.mock.calls[0][0];
    expect(isMatch(auditEvent('key.deleted', { keyKind: 's3', keyName: 'any-key' }))).toBe(true);
  });

  it('leaves out events older than where the audit read stopped early, so the order holds', async () => {
    // Another type's read stopped at 10-01, so an older row could be outranked
    // by one it left unread.
    mockQueryRecentAuditEvents.mockResolvedValue({
      events: [
        { ...auditEvent('bucket.deleted', BUCKET, 'at-cutoff') },
        {
          ...auditEvent('bucket.deleted', BUCKET, 'below-cutoff'),
          createdAt: '2026-09-30T00:00:00.000Z',
        },
      ],
      cost: { pages: 3, rows: 300 },
      completeSince: '2026-10-01T00:00:00.000Z',
    });

    expect((await getActivities()).body.activities).toStrictEqual([
      expect.objectContaining({ id: 'at-cutoff' }),
    ]);
  });

  it.each([
    ['the requested limit', { limit: '3' }, 3],
    ['10 when no limit is given', undefined, 10],
    ['10 when the limit is not a number', { limit: 'abc' }, 10],
    ['1 when the limit is negative', { limit: '-5' }, 1],
    ['50 when the limit is above 50', { limit: '100' }, 50],
  ])('asks the audit log for %s', async (_case, query, limit) => {
    await getActivities(query);

    expect(mockQueryRecentAuditEvents).toHaveBeenCalledWith(
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
      expect(mockQueryRecentAuditEvents).toHaveBeenCalledWith(
        expect.objectContaining({ from: earliest, to: NOW }),
      );
    });
  });

  it('cancels the read with the request deadline', async () => {
    const deadline = new AbortController().signal;

    await baseHandler(buildEvent({ userInfo: USER_INFO, requestContext: { deadline } }));

    expect(mockQueryRecentAuditEvents).toHaveBeenCalledWith(
      expect.objectContaining({ signal: deadline }),
    );
  });

  it('reports the audit query’s own duration, not the bucket listing’s', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    mockQueryRecentAuditEvents.mockImplementation(async () => {
      now += 10;
      return { events: [], cost: { pages: 1, rows: 0 } };
    });
    // The listing finishes after the audit query, 1s later.
    mockListBuckets.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      now += 1000;
      return [];
    });

    await getActivities();

    expect(mockReportAuditQuery).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 10 }));
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

describe('get-activity buckets created outside the console', () => {
  const NOW = '2026-12-15T12:00:00.000Z';
  const RECENT = '2026-12-10T00:00:00.000Z';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    resolveEvents();
    mockGetProvisionedNetworks.mockResolvedValue([ANY_NETWORK]);
    mockListBuckets.mockResolvedValue([]);
  });
  afterEach(() => vi.useRealTimers());

  function created(bucketName: string, createdAt: string, region = 'any-region') {
    return { ...auditEvent('bucket.created', { region, bucketName }), createdAt } as AuditEvent;
  }

  /** A `bucket.created` intent the console never completed. */
  function intent(bucketName: string, createdAt: string, region = 'any-region') {
    const { outcome: _outcome, ...event } = created(bucketName, createdAt, region);
    return { ...event, eventId: 'any-intent', phase: 'intent' } as AuditEvent;
  }

  it('adds an unattributed creation row for a listed bucket the audit log has no creation for', async () => {
    mockListBuckets.mockResolvedValue([listedBucket('any-bucket', RECENT)]);

    expect((await getActivities()).body).toStrictEqual({
      activities: [
        {
          id: `unrecorded:any-region:any-bucket:${RECENT}`,
          action: 'bucket.created',
          resourceType: 'bucket',
          resourceName: 'any-bucket',
          timestamp: RECENT,
          createdOutsideConsole: true,
        },
      ],
    });
  });

  it('adds no row for a bucket whose creation the audit log recorded', async () => {
    // The console writes the event a moment after the storage system made the bucket.
    resolveEvents(created('any-bucket', '2026-12-10T00:00:01.000Z'));
    mockListBuckets.mockResolvedValue([listedBucket('any-bucket', RECENT)]);

    expect((await getActivities()).body).toStrictEqual({
      activities: [
        {
          id: 'any-event',
          action: 'bucket.created',
          resourceType: 'bucket',
          resourceName: 'any-bucket',
          timestamp: '2026-12-10T00:00:01.000Z',
        },
      ],
    });
  });

  it('adds no row for a bucket whose recorded creation is stamped a few seconds before it', async () => {
    // The storage system's clock runs a little ahead of Lambda's.
    resolveEvents(created('any-bucket', '2026-12-09T23:59:55.000Z'));
    mockListBuckets.mockResolvedValue([listedBucket('any-bucket', RECENT)]);

    expect((await getActivities()).body.activities).toStrictEqual([
      expect.objectContaining({ id: 'any-event' }),
    ]);
  });

  it('adds an outside-the-console row for a bucket whose recorded creation is over five minutes older', async () => {
    resolveEvents(created('any-bucket', '2026-12-09T23:54:59.000Z'));
    mockListBuckets.mockResolvedValue([listedBucket('any-bucket', RECENT)]);

    expect((await getActivities()).body.activities).toStrictEqual([
      expect.objectContaining({ timestamp: RECENT, createdOutsideConsole: true }),
      expect.objectContaining({ id: 'any-event' }),
    ]);
  });

  it('adds a plain creation row for a bucket whose console create was never completed', async () => {
    // The storage call timed out, so the intent stayed open; the bucket was made.
    resolveEvents(intent('any-bucket', '2026-12-09T23:59:59.000Z'));
    mockListBuckets.mockResolvedValue([listedBucket('any-bucket', RECENT)]);

    expect((await getActivities()).body).toStrictEqual({
      activities: [
        {
          id: `unrecorded:any-region:any-bucket:${RECENT}`,
          action: 'bucket.created',
          resourceType: 'bucket',
          resourceName: 'any-bucket',
          timestamp: RECENT,
        },
      ],
    });
  });

  it('adds an outside-the-console row for a bucket whose console create failed', async () => {
    // The console's attempt was refused, so the bucket was made some other way.
    // The intent and its completion share a correlation id.
    resolveEvents(
      { ...created('any-bucket', '2026-12-09T23:59:59.500Z'), outcome: 'failed' } as AuditEvent,
      intent('any-bucket', '2026-12-09T23:59:59.000Z'),
    );
    mockListBuckets.mockResolvedValue([listedBucket('any-bucket', RECENT)]);

    expect((await getActivities()).body).toMatchObject({
      activities: [{ createdOutsideConsole: true }],
    });
  });

  it('adds an outside-the-console row when the only open console create is for another region', async () => {
    resolveEvents(intent('any-bucket', '2026-12-09T23:59:59.000Z', 'other-region'));
    mockListBuckets.mockResolvedValue([listedBucket('any-bucket', RECENT)]);

    expect((await getActivities()).body).toMatchObject({
      activities: [{ createdOutsideConsole: true }],
    });
  });

  it('adds a row for a bucket of the same name in another region', async () => {
    // Stamped just after the listed bucket, so only the region tells them apart.
    resolveEvents(created('any-bucket', '2026-12-10T00:00:01.000Z', 'other-region'));
    mockListBuckets.mockResolvedValue([listedBucket('any-bucket', RECENT)]);

    expect((await getActivities()).body.activities).toMatchObject([
      { id: 'any-event' },
      { createdOutsideConsole: true },
    ]);
  });

  it('adds a row for a bucket made again outside the console after an older console creation', async () => {
    // The console made the first `any-bucket`; it was deleted and made again
    // with the S3 API a week later.
    resolveEvents(created('any-bucket', '2026-12-03T00:00:00.000Z'));
    mockListBuckets.mockResolvedValue([listedBucket('any-bucket', RECENT)]);

    expect((await getActivities()).body.activities).toMatchObject([
      { createdOutsideConsole: true, timestamp: RECENT },
      { id: 'any-event' },
    ]);
  });

  it('adds a plain creation row for a bucket made before the console audited bucket creations', async () => {
    // The log could not have recorded this one, whichever way it was made.
    vi.setSystemTime(new Date('2026-11-20T12:00:00.000Z'));
    mockListBuckets.mockResolvedValue([listedBucket('any-bucket', '2026-11-05T00:00:00.000Z')]);

    expect((await getActivities()).body).toStrictEqual({
      activities: [
        {
          id: 'unrecorded:any-region:any-bucket:2026-11-05T00:00:00.000Z',
          action: 'bucket.created',
          resourceType: 'bucket',
          resourceName: 'any-bucket',
          timestamp: '2026-11-05T00:00:00.000Z',
        },
      ],
    });
  });

  it('leaves out a bucket created before the retention window', async () => {
    mockListBuckets.mockResolvedValue([listedBucket('any-bucket', '2026-01-01T00:00:00.000Z')]);

    expect((await getActivities()).body).toStrictEqual({ activities: [] });
  });

  it('leaves out a bucket created before the point the audit read stopped early', async () => {
    // Older creations were left unread, so the log may hold this one's.
    mockQueryRecentAuditEvents.mockResolvedValue({
      events: [],
      cost: { pages: 3, rows: 300 },
      completeSince: '2026-12-12T00:00:00.000Z',
    });
    mockListBuckets.mockResolvedValue([listedBucket('any-bucket', RECENT)]);

    expect((await getActivities()).body).toStrictEqual({ activities: [] });
  });

  it('adds no row for a bucket whose recorded creation is just below the point the audit read stopped', async () => {
    // The creation is stamped a few seconds before the bucket, and the read
    // stopped between the two, so the creation is not a feed row but still
    // records the bucket.
    const creation = created('any-bucket', '2026-12-09T23:59:55.000Z');
    mockQueryRecentAuditEvents.mockResolvedValue({
      events: [creation],
      cost: { pages: 3, rows: 300 },
      completeSince: '2026-12-09T23:59:58.000Z',
    });
    mockListBuckets.mockResolvedValue([listedBucket('any-bucket', RECENT)]);

    expect((await getActivities()).body).toStrictEqual({ activities: [] });
  });

  it('leaves out Bucket Intelligence companion buckets', async () => {
    mockListBuckets.mockResolvedValue([listedBucket(`filone-rag-${'a'.repeat(40)}`, RECENT)]);

    expect((await getActivities()).body).toStrictEqual({ activities: [] });
  });

  it('merges both kinds of row newest first and cuts them to the limit', async () => {
    resolveEvents(
      created('console-new', '2026-12-12T00:00:00.000Z'),
      created('console-old', '2026-12-08T00:00:00.000Z'),
    );
    mockListBuckets.mockResolvedValue([
      listedBucket('console-new', '2026-12-12T00:00:00.000Z'),
      listedBucket('console-old', '2026-12-08T00:00:00.000Z'),
      listedBucket('outside', RECENT),
    ]);

    expect((await getActivities({ limit: '2' })).body.activities).toMatchObject([
      { resourceName: 'console-new' },
      { resourceName: 'outside', createdOutsideConsole: true },
    ]);
  });

  it('still returns the audit events when a network fails to list its buckets', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    resolveEvents(created('any-bucket', RECENT));
    mockListBuckets.mockRejectedValue(new Error('any-error'));

    expect((await getActivities()).body).toMatchObject({ activities: [{ id: 'any-event' }] });
  });

  it('still returns the audit events when the org’s networks cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    resolveEvents(created('any-bucket', RECENT));
    mockGetProvisionedNetworks.mockRejectedValue(new Error('any-error'));

    expect(await getActivities()).toStrictEqual({
      statusCode: 200,
      body: { activities: [expect.objectContaining({ id: 'any-event' })] },
    });
  });

  it('lists every bucket in the tenant, under the request deadline', async () => {
    const deadline = new AbortController().signal;

    await baseHandler(buildEvent({ userInfo: USER_INFO, requestContext: { deadline } }));

    expect(mockListBuckets).toHaveBeenCalledWith('any-tenant', undefined, { signal: deadline });
  });
});
