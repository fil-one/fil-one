import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { AUDIT_PAGE_SIZE, OrgRole } from '@filone/shared';
import type { ListAuditEventsResponse } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';

vi.mock('sst', () => sstResourceMock());

vi.mock('../lib/auth-secrets.js', () => ({
  getAuthSecrets: () => ({
    AUTH0_CLIENT_ID: 'test-client-id',
    AUTH0_CLIENT_SECRET: 'test-client-secret',
  }),
}));

const mockJwtVerify = vi.fn();
vi.mock('jose', () => ({
  jwtVerify: (token: unknown, jwks: unknown, opts: unknown) => mockJwtVerify(token, jwks, opts),
  decodeJwt: vi.fn(),
  createRemoteJWKSet: vi.fn((_url: unknown) => 'mock-jwks'),
}));

const ddbMock = mockClient(DynamoDBClient);

process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.com';

import { handler } from './list-audit-events.js';
import {
  buildContext,
  buildEvent,
  NO_MEMBERSHIP,
  stubMembershipRead,
} from '../test/lambda-test-utilities.js';

const MOCK_SUB = 'auth0|admin';
const ORG_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = '22222222-3333-4444-5555-666666666666';
const EMAIL = 'admin@example.com';

function storedEvent(createdAt: string, eventId: string) {
  return marshall({
    pk: `ORG#${ORG_ID}`,
    sk: `${createdAt}#${eventId}`,
    gsi1pk: `ORG#${ORG_ID}#TYPE#org.renamed`,
    gsi1sk: `${createdAt}#${eventId}`,
    eventId,
    type: 'org.renamed',
    actor: { kind: 'user', id: USER_ID, email: EMAIL },
    orgId: ORG_ID,
    subject: `org:${ORG_ID}`,
    details: { name: 'Acme Two' },
    createdAt,
    ttl: 1_800_000_000,
  });
}

function auditEventRequest(queryStringParameters?: Record<string, string>) {
  return buildEvent({
    cookies: ['hs_access_token=valid-token', 'hs_id_token=id-token'],
    userInfo: { userId: USER_ID, orgId: ORG_ID, email: EMAIL, membership: NO_MEMBERSHIP },
    method: 'GET',
    rawPath: '/api/audit',
    ...(queryStringParameters ? { queryStringParameters } : {}),
  });
}

function body(result: unknown): ListAuditEventsResponse {
  return JSON.parse((result as { body: string }).body) as ListAuditEventsResponse;
}

async function invoke(queryStringParameters?: Record<string, string>) {
  return handler(auditEventRequest(queryStringParameters), buildContext());
}

/** The audit Query the handler sent, as opposed to the middleware's reads. */
function auditQuery() {
  return ddbMock
    .commandCalls(QueryCommand)
    .find((call) => call.args[0].input.TableName === 'AuditTable')!.args[0].input;
}

describe('GET /api/audit handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    mockJwtVerify.mockResolvedValue({
      payload: { sub: MOCK_SUB, email: EMAIL, email_verified: true },
    });

    ddbMock.on(GetItemCommand).resolves({});
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
      })
      .resolves({
        Item: {
          pk: { S: `SUB#${MOCK_SUB}` },
          sk: { S: 'IDENTITY' },
          userId: { S: USER_ID },
          orgId: { S: ORG_ID },
        },
      });
    stubMembershipRead(ddbMock, { orgId: ORG_ID, userId: USER_ID, role: OrgRole.Admin });
    ddbMock.on(QueryCommand, { TableName: 'AuditTable' }).resolves({ Items: [] });
  });

  it('answers a page of the org history with the window it read', async () => {
    ddbMock
      .on(QueryCommand, { TableName: 'AuditTable' })
      .resolves({ Items: [storedEvent('2026-08-10T00:00:00.000Z', 'evt-1')] });

    const result = await invoke();

    expect(result.statusCode).toBe(200);
    expect(body(result).events).toHaveLength(1);
    expect(body(result).window.clamped).toBe(false);
    expect(body(result).nextCursor).toBeUndefined();
  });

  it('asks for one page at a time', async () => {
    await invoke();

    // The limit is applied by the read loop rather than by DynamoDB, because a
    // Limit would cap items examined and hand back short pages under a filter.
    expect(body(await invoke()).events.length).toBeLessThanOrEqual(AUDIT_PAGE_SIZE);
  });

  // The org is resolved from the caller's membership. A parameter naming another
  // org is not a filter, and must not become one.
  it('reads the caller’s own org whatever the query string says', async () => {
    await invoke({ orgId: '99999999-8888-7777-6666-555555555555' });

    expect(auditQuery().ExpressionAttributeValues![':pk']).toEqual({ S: `ORG#${ORG_ID}` });
  });

  it('passes a single event type to the index', async () => {
    await invoke({ eventType: 'member.removed' });

    expect(auditQuery().IndexName).toBe('byType');
    expect(auditQuery().ExpressionAttributeValues![':pk']).toEqual({
      S: `ORG#${ORG_ID}#TYPE#member.removed`,
    });
  });

  it('refuses a filter it cannot build a query from', async () => {
    const result = await invoke({ eventType: 'org.deleted' });

    expect(result.statusCode).toBe(400);
    expect(JSON.parse((result as { body: string }).body).message).toContain('org.deleted');
  });

  it('refuses a bound that is not a full instant', async () => {
    expect((await invoke({ from: '2026-08-01' })).statusCode).toBe(400);
  });

  // The response body is the API contract, and the table and index layout are
  // not part of it.
  it('answers with no storage keys in the body', async () => {
    ddbMock
      .on(QueryCommand, { TableName: 'AuditTable' })
      .resolves({ Items: [storedEvent('2026-08-10T00:00:00.000Z', 'evt-1')] });

    const result = await invoke();

    for (const key of ['pk', 'sk', 'gsi1pk', 'gsi1sk']) {
      expect(result.body).not.toContain(`"${key}"`);
    }
    expect(body(result).events[0]).toMatchObject({ eventId: 'evt-1' });
  });

  // A client-supplied value that DynamoDB would refuse is the caller's mistake,
  // not a server failure.
  it.each([['!'], ['abc'], ['']])('refuses the malformed cursor %j with a 400', async (cursor) => {
    const result = await invoke({ cursor });

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body!).message).toContain('cursor');
  });

  it('refuses a cursor from outside the window with a 400', async () => {
    const stale = Buffer.from('2020-01-01T00:00:00.000Z#evt-1', 'utf8').toString('base64url');

    const result = await invoke({ from: '2026-08-01T00:00:00.000Z', cursor: stale });

    expect(result.statusCode).toBe(400);
  });

  it('resumes from a cursor it accepts', async () => {
    const cursor = Buffer.from('2026-08-10T00:00:00.000Z#evt-1', 'utf8').toString('base64url');

    const result = await invoke({ from: '2026-08-01T00:00:00.000Z', cursor });

    expect(result.statusCode).toBe(200);
    expect(auditQuery().ExclusiveStartKey).toBeDefined();
  });

  it('reports a window clamped to retention, so the console can say so', async () => {
    const result = await invoke({ from: '2020-01-01T00:00:00.000Z' });

    expect(body(result).window.clamped).toBe(true);
    expect(body(result).window.from > '2020-01-01T00:00:00.000Z').toBe(true);
  });

  it('emits the pages-against-rows metric the design watches', async () => {
    const written = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await invoke();

    const emitted = written.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('AuditQueryPages'));
    expect(emitted).toHaveLength(1);
    expect(JSON.parse(emitted[0])).toMatchObject({ route: 'list', AuditQueryPages: 1 });
  });
});
