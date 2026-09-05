import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { ApiErrorCode, OrgRole } from '@filone/shared';
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

import { handler } from './export-audit-events.js';
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

function storedEvent(eventId: string, details: Record<string, unknown> = { name: 'Acme Two' }) {
  return marshall({
    pk: `ORG#${ORG_ID}`,
    sk: `2026-08-10T00:00:00.000Z#${eventId}`,
    eventId,
    type: 'org.renamed',
    actor: { kind: 'user', id: USER_ID, email: EMAIL },
    orgId: ORG_ID,
    subject: `org:${ORG_ID}`,
    details,
    createdAt: '2026-08-10T00:00:00.000Z',
    ttl: 1_800_000_000,
  });
}

async function invoke(queryStringParameters?: Record<string, string>) {
  return handler(
    buildEvent({
      cookies: ['hs_access_token=valid-token', 'hs_id_token=id-token'],
      userInfo: { userId: USER_ID, orgId: ORG_ID, email: EMAIL, membership: NO_MEMBERSHIP },
      method: 'GET',
      rawPath: '/api/audit/export',
      ...(queryStringParameters ? { queryStringParameters } : {}),
    }),
    buildContext(),
  );
}

/** The `audit.exported` event the handler appended, if it appended one. */
function exportedEvent() {
  const call = ddbMock
    .commandCalls(PutItemCommand)
    .find((c) => c.args[0].input.TableName === 'AuditTable');
  return call ? unmarshall(call.args[0].input.Item!) : undefined;
}

describe('GET /api/audit/export handler', () => {
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
    stubMembershipRead(ddbMock, { orgId: ORG_ID, userId: USER_ID, role: OrgRole.Owner });
    ddbMock
      .on(QueryCommand, { TableName: 'AuditTable' })
      .resolves({ Items: [storedEvent('evt-1')] });
    ddbMock.on(PutItemCommand).resolves({});
  });

  it('answers with the CSV as a download', async () => {
    const result = await invoke();

    expect(result.statusCode).toBe(200);
    expect(result.headers!['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(result.headers!['Content-Disposition']).toContain('attachment; filename="audit-log-');
    expect(result.body).toContain('"evt-1"');
  });

  // A downloaded file is what a browser is most willing to guess the type of.
  it('keeps the security headers the JSON responses carry', async () => {
    const headers = (await invoke()).headers!;

    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Strict-Transport-Security']).toBe('max-age=2592000; includeSubDomains');
  });

  it('records the export, with the filters and the row count', async () => {
    await invoke({ eventType: 'org.renamed', actorId: USER_ID });

    expect(exportedEvent()).toMatchObject({
      type: 'audit.exported',
      orgId: ORG_ID,
      subject: `org:${ORG_ID}`,
      actor: { kind: 'user', id: USER_ID, email: EMAIL },
      details: { eventType: 'org.renamed', actorId: USER_ID, rowCount: 1 },
    });
  });

  // The only GET in the API that writes, and the highest-signal action the log
  // holds: it is the one that takes the org's history out of the system.
  it('records the export even when it matched nothing', async () => {
    ddbMock.on(QueryCommand, { TableName: 'AuditTable' }).resolves({ Items: [] });

    await invoke();

    expect(exportedEvent()).toMatchObject({ details: { rowCount: 0 } });
  });

  it('refuses an export over the row cap rather than truncating it', async () => {
    const many = Array.from({ length: 20_001 }, (_, i) => storedEvent(`evt-${i}`));
    ddbMock.on(QueryCommand, { TableName: 'AuditTable' }).resolves({ Items: many });

    const result = await invoke();

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body!).code).toBe(ApiErrorCode.AUDIT_EXPORT_TOO_LARGE);
  });

  // A refused export must not leave a record saying one was produced.
  it('records nothing when the export was refused', async () => {
    const many = Array.from({ length: 20_001 }, (_, i) => storedEvent(`evt-${i}`));
    ddbMock.on(QueryCommand, { TableName: 'AuditTable' }).resolves({ Items: many });

    await invoke();

    expect(exportedEvent()).toBeUndefined();
  });

  it('refuses a filter it cannot build a query from', async () => {
    const result = await invoke({ actorId: 'owner@example.com' });

    expect(result.statusCode).toBe(400);
    expect(exportedEvent()).toBeUndefined();
  });

  it('emits the export metric', async () => {
    const written = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await invoke();

    const emitted = written.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('AuditQueryPages'));
    expect(JSON.parse(emitted[0])).toMatchObject({ route: 'export' });
  });
});
