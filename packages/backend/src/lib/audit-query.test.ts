import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { AUDIT_RETENTION_DAYS } from '@filone/shared';
import type { AuditQueryFilters } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';

vi.mock('sst', () => sstResourceMock());

const ddbMock = mockClient(DynamoDBClient);

import { queryAllAuditEvents, queryAuditEvents, resolveWindow } from './audit-query.js';

const ORG_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_ORG = '99999999-8888-7777-6666-555555555555';
const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NOW = '2026-08-15T12:00:00.000Z';
const WINDOW: AuditQueryFilters = { from: '2026-08-01T00:00:00.000Z', to: NOW };

/** A stored row, as DynamoDB hands it back. */
function storedEvent(createdAt: string, eventId: string, type = 'org.renamed') {
  return marshall({
    pk: `ORG#${ORG_ID}`,
    sk: `${createdAt}#${eventId}`,
    gsi1pk: `ORG#${ORG_ID}#TYPE#${type}`,
    gsi1sk: `${createdAt}#${eventId}`,
    eventId,
    type,
    actor: { kind: 'user', id: USER_ID, email: 'owner@example.com' },
    orgId: ORG_ID,
    subject: `org:${ORG_ID}`,
    details: { name: 'Acme Two' },
    createdAt,
    ttl: 1_800_000_000,
  });
}

/** The input of the nth Query the read path sent. */
function queryInput(n = 0) {
  return ddbMock.commandCalls(QueryCommand)[n].args[0].input;
}

describe('resolveWindow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => vi.useRealTimers());

  it('leaves a window inside retention alone', () => {
    expect(resolveWindow(WINDOW)).toEqual({ ...WINDOW, clamped: false });
  });

  // Asking for everything is not asking for more than exists. A console told it
  // was clamped on every unfiltered page load would learn to ignore the notice.
  it('fills an absent lower bound without calling it a clamp', () => {
    const window = resolveWindow({ to: NOW });

    const earliest = new Date(
      Date.parse(NOW) - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(window).toEqual({ from: earliest, to: NOW, clamped: false });
  });

  // Silently returning a quarter to someone who asked for half a year reads as
  // data loss, so the clamp is reported rather than just applied.
  it('clamps a request reaching past retention and says so', () => {
    const window = resolveWindow({ from: '2026-01-01T00:00:00.000Z', to: NOW });

    const earliest = new Date(
      Date.parse(NOW) - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(window).toEqual({ from: earliest, to: NOW, clamped: true });
  });

  // Clamping it would make a range picked in a timezone ahead of UTC look
  // truncated for no benefit.
  it('leaves an upper bound in the future alone', () => {
    const window = resolveWindow({ from: WINDOW.from, to: '2027-01-01T00:00:00.000Z' });

    expect(window.to).toBe('2027-01-01T00:00:00.000Z');
    expect(window.clamped).toBe(false);
  });
});

describe('queryAuditEvents', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    ddbMock.on(QueryCommand).resolves({ Items: [] });
  });
  afterEach(() => vi.useRealTimers());

  it('reads the org partition over the range, newest first', async () => {
    await queryAuditEvents({ orgId: ORG_ID, filters: WINDOW, limit: 50 });

    const input = queryInput();
    expect(input.TableName).toBe('AuditTable');
    expect(input.IndexName).toBeUndefined();
    expect(input.KeyConditionExpression).toBe('pk = :pk AND sk BETWEEN :from AND :to');
    expect(input.ExpressionAttributeValues![':pk']).toEqual({ S: `ORG#${ORG_ID}` });
    expect(input.ScanIndexForward).toBe(false);
  });

  it('moves to the event-type index when exactly one type is named', async () => {
    await queryAuditEvents({
      orgId: ORG_ID,
      filters: { ...WINDOW, eventType: 'member.removed' },
      limit: 50,
    });

    const input = queryInput();
    expect(input.IndexName).toBe('byType');
    expect(input.KeyConditionExpression).toBe('gsi1pk = :pk AND gsi1sk BETWEEN :from AND :to');
    // Still org-scoped, so a type filter narrows a caller's own history and can
    // never reach across orgs.
    expect(input.ExpressionAttributeValues![':pk']).toEqual({
      S: `ORG#${ORG_ID}#TYPE#member.removed`,
    });
  });

  // DynamoDB serves an expired item for up to 48 hours after its TTL passes, and
  // the promise made to the customer is 90 days.
  it('excludes rows past their TTL on both paths', async () => {
    await queryAuditEvents({ orgId: ORG_ID, filters: WINDOW, limit: 50 });
    await queryAuditEvents({
      orgId: ORG_ID,
      filters: { ...WINDOW, eventType: 'org.renamed' },
      limit: 50,
    });

    for (const n of [0, 1]) {
      expect(queryInput(n).FilterExpression).toContain('#ttl > :now');
      expect(queryInput(n).ExpressionAttributeNames).toEqual({ '#ttl': 'ttl' });
      expect(queryInput(n).ExpressionAttributeValues![':now']).toEqual({
        N: String(Math.floor(Date.parse(NOW) / 1000)),
      });
    }
  });

  it('filters an actor by id, never by address', async () => {
    await queryAuditEvents({
      orgId: ORG_ID,
      filters: { ...WINDOW, actorId: USER_ID },
      limit: 50,
    });

    const input = queryInput();
    expect(input.FilterExpression).toBe('#ttl > :now AND actor.id = :actorId');
    expect(input.ExpressionAttributeValues![':actorId']).toEqual({ S: USER_ID });
    expect(JSON.stringify(input)).not.toContain('actor.email');
  });

  it('returns the events it matched, unmarshalled', async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [storedEvent('2026-08-10T00:00:00.000Z', 'evt-1')] });

    const page = await queryAuditEvents({ orgId: ORG_ID, filters: WINDOW, limit: 50 });

    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ eventId: 'evt-1', type: 'org.renamed' });
    expect(page.window).toEqual({ ...WINDOW, clamped: false });
    expect(page.nextCursor).toBeUndefined();
  });

  // A filtered Query can examine a megabyte, match none of it, and still hand
  // back a LastEvaluatedKey. A handler that answered there would show an empty
  // page above a "next" button for a filter that does match something.
  it('keeps reading past a page that matched nothing', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [], LastEvaluatedKey: marshall({ pk: 'x', sk: 'y' }) })
      .resolvesOnce({ Items: [], LastEvaluatedKey: marshall({ pk: 'x', sk: 'z' }) })
      .resolvesOnce({ Items: [storedEvent('2026-08-10T00:00:00.000Z', 'evt-1')] });

    const page = await queryAuditEvents({ orgId: ORG_ID, filters: WINDOW, limit: 50 });

    expect(page.events).toHaveLength(1);
    expect(page.cost.pages).toBe(3);
  });

  it('stops at the page size and hands back a cursor', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        storedEvent('2026-08-10T00:00:00.000Z', 'evt-1'),
        storedEvent('2026-08-09T00:00:00.000Z', 'evt-2'),
      ],
      LastEvaluatedKey: marshall({ pk: 'x', sk: 'y' }),
    });

    const page = await queryAuditEvents({ orgId: ORG_ID, filters: WINDOW, limit: 1 });

    expect(page.events).toHaveLength(1);
    // Resumes from the event returned, not from the end of a page whose tail
    // this response never sent.
    expect(Buffer.from(page.nextCursor!, 'base64url').toString('utf8')).toBe(
      '2026-08-10T00:00:00.000Z#evt-1',
    );
  });

  // pk/sk/gsi1pk/gsi1sk are where the row lives, not part of what it records,
  // and they are absent from the envelope in shared. A bare unmarshall would put
  // the table and index layout into every response.
  it('drops the storage keys from the events it returns', async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [storedEvent('2026-08-10T00:00:00.000Z', 'evt-1')] });

    const page = await queryAuditEvents({ orgId: ORG_ID, filters: WINDOW, limit: 50 });

    expect(Object.keys(page.events[0]).sort()).toEqual([
      'actor',
      'createdAt',
      'details',
      'eventId',
      'orgId',
      'subject',
      'ttl',
      'type',
    ]);
  });

  it('keeps the phase fields of a two-phase event', async () => {
    const intent = marshall({
      ...unmarshall(storedEvent('2026-08-10T00:00:00.000Z', 'evt-1', 'key.created')),
      phase: 'intent',
      correlationId: 'corr-1',
    });
    ddbMock.on(QueryCommand).resolves({ Items: [intent] });

    const page = await queryAuditEvents({ orgId: ORG_ID, filters: WINDOW, limit: 50 });

    expect(page.events[0]).toMatchObject({ phase: 'intent', correlationId: 'corr-1' });
    expect(page.events[0]).not.toHaveProperty('gsi1pk');
  });

  // A cursor a client follows has to yield something. LastEvaluatedKey proves
  // only that more items were examined, and under a filter the window can end
  // exactly on the page boundary.
  it('gives no cursor when the window holds exactly one page', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        storedEvent('2026-08-10T00:00:00.000Z', 'evt-1'),
        storedEvent('2026-08-09T00:00:00.000Z', 'evt-2'),
      ],
    });

    const page = await queryAuditEvents({ orgId: ORG_ID, filters: WINDOW, limit: 2 });

    expect(page.events).toHaveLength(2);
    expect(page.nextCursor).toBeUndefined();
  });

  it('gives a cursor once a further match is actually seen', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        storedEvent('2026-08-10T00:00:00.000Z', 'evt-1'),
        storedEvent('2026-08-09T00:00:00.000Z', 'evt-2'),
        storedEvent('2026-08-08T00:00:00.000Z', 'evt-3'),
      ],
    });

    const page = await queryAuditEvents({ orgId: ORG_ID, filters: WINDOW, limit: 2 });

    expect(page.events.map((event) => event.eventId)).toEqual(['evt-1', 'evt-2']);
    // Names the last event returned, so ExclusiveStartKey resumes after it.
    expect(Buffer.from(page.nextCursor!, 'base64url').toString('utf8')).toBe(
      '2026-08-09T00:00:00.000Z#evt-2',
    );
  });

  it('keeps draining pages until the extra match is found', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({
        Items: [storedEvent('2026-08-10T00:00:00.000Z', 'evt-1')],
        LastEvaluatedKey: marshall({ pk: 'x', sk: 'y' }),
      })
      .resolvesOnce({ Items: [], LastEvaluatedKey: marshall({ pk: 'x', sk: 'z' }) })
      .resolvesOnce({ Items: [storedEvent('2026-08-09T00:00:00.000Z', 'evt-2')] });

    const page = await queryAuditEvents({ orgId: ORG_ID, filters: WINDOW, limit: 1 });

    expect(page.events.map((event) => event.eventId)).toEqual(['evt-1']);
    expect(page.cost.pages).toBe(3);
    expect(page.nextCursor).toBeDefined();
  });

  it('gives no cursor when the window ran out before the page filled', async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [storedEvent('2026-08-10T00:00:00.000Z', 'evt-1')] });

    const page = await queryAuditEvents({ orgId: ORG_ID, filters: WINDOW, limit: 50 });

    expect(page.nextCursor).toBeUndefined();
  });

  it('resumes from a cursor', async () => {
    const cursor = Buffer.from('2026-08-10T00:00:00.000Z#evt-1', 'utf8').toString('base64url');

    await queryAuditEvents({ orgId: ORG_ID, filters: WINDOW, limit: 50, cursor });

    expect(queryInput().ExclusiveStartKey).toEqual(
      marshall({ pk: `ORG#${ORG_ID}`, sk: '2026-08-10T00:00:00.000Z#evt-1' }),
    );
  });

  // The one thing a client-supplied cursor must not be able to do. Only the sort
  // key travels; the partition is rebuilt from the caller's own org.
  it('ignores an org named by the cursor and reads the caller’s own', async () => {
    const forged = Buffer.from('2026-08-10T00:00:00.000Z#evt-1', 'utf8').toString('base64url');

    await queryAuditEvents({ orgId: ORG_ID, filters: WINDOW, limit: 50, cursor: forged });

    const startKey = queryInput().ExclusiveStartKey!;
    expect(startKey.pk).toEqual({ S: `ORG#${ORG_ID}` });
    expect(JSON.stringify(startKey)).not.toContain(OTHER_ORG);
  });

  it('carries the index keys on a resumed type-filtered read', async () => {
    const cursor = Buffer.from('2026-08-10T00:00:00.000Z#evt-1', 'utf8').toString('base64url');

    await queryAuditEvents({
      orgId: ORG_ID,
      filters: { ...WINDOW, eventType: 'key.created' },
      limit: 50,
      cursor,
    });

    // An index entry is addressed by both its own key and the base table's.
    expect(queryInput().ExclusiveStartKey).toEqual(
      marshall({
        gsi1pk: `ORG#${ORG_ID}#TYPE#key.created`,
        gsi1sk: '2026-08-10T00:00:00.000Z#evt-1',
        pk: `ORG#${ORG_ID}`,
        sk: '2026-08-10T00:00:00.000Z#evt-1',
      }),
    );
  });

  it('counts pages and items read, which is what says an org has outgrown this', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({
        Items: [storedEvent('2026-08-10T00:00:00.000Z', 'evt-1')],
        LastEvaluatedKey: marshall({ pk: 'x', sk: 'y' }),
      })
      .resolvesOnce({ Items: [storedEvent('2026-08-09T00:00:00.000Z', 'evt-2')] });

    const page = await queryAuditEvents({ orgId: ORG_ID, filters: WINDOW, limit: 50 });

    expect(page.cost).toEqual({ pages: 2, rows: 2 });
  });
});

describe('queryAllAuditEvents', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => vi.useRealTimers());

  it('reports nothing truncated when the result is under the cap', async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [storedEvent('2026-08-10T00:00:00.000Z', 'evt-1')] });

    const result = await queryAllAuditEvents({ orgId: ORG_ID, filters: WINDOW, maxRows: 10 });

    expect(result.truncated).toBe(false);
    expect(result.events).toHaveLength(1);
  });

  // An export of exactly the cap is complete, and refusing it would be wrong.
  it('does not call a result that lands exactly on the cap truncated', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        storedEvent('2026-08-10T00:00:00.000Z', 'evt-1'),
        storedEvent('2026-08-09T00:00:00.000Z', 'evt-2'),
      ],
    });

    const result = await queryAllAuditEvents({ orgId: ORG_ID, filters: WINDOW, maxRows: 2 });

    expect(result.truncated).toBe(false);
    expect(result.events).toHaveLength(2);
  });

  it('reports truncation once the result passes the cap', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        storedEvent('2026-08-10T00:00:00.000Z', 'evt-1'),
        storedEvent('2026-08-09T00:00:00.000Z', 'evt-2'),
        storedEvent('2026-08-08T00:00:00.000Z', 'evt-3'),
      ],
    });

    const result = await queryAllAuditEvents({ orgId: ORG_ID, filters: WINDOW, maxRows: 2 });

    expect(result.truncated).toBe(true);
  });
});
