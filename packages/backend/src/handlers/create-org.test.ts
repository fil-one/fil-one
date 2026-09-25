import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { MAX_OWNED_ORGS, OrgRole } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.ts';
import { auditItemIn, expectNoSecrets } from '../test/audit-assertions.ts';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

const mockListMemberships = vi.fn();

// Only the ownership count is stubbed; the membership read the middleware makes
// still goes through the real module.
vi.mock('../lib/org-membership.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/org-membership.ts')>()),
  listMemberships: (...args: unknown[]) => mockListMemberships(...args),
}));

const ddbMock = mockClient(DynamoDBClient);

process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.com';

import { handler } from './create-org.ts';
import {
  buildEvent,
  buildContext,
  NO_MEMBERSHIP,
  stubAbsentMembershipRead,
  stubMembershipRead,
} from '../test/lambda-test-utilities.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SUB = 'auth0|abc123';
const MOCK_ORG_ID = 'org-1';
const MOCK_USER_ID = 'user-1';
const MOCK_EMAIL = 'user@example.com';
const MOCK_CSRF_TOKEN = 'csrf-token-value';

function createOrgEvent(body: unknown) {
  const event = buildEvent({
    cookies: [
      `hs_access_token=valid-token`,
      `hs_id_token=id-token`,
      `hs_csrf_token=${MOCK_CSRF_TOKEN}`,
    ],
    userInfo: {
      userId: MOCK_USER_ID,
      orgId: MOCK_ORG_ID,
      email: MOCK_EMAIL,
      // Nothing stamped here: the real chain runs and reads the caller's own
      // active-org membership off the row.
      membership: NO_MEMBERSHIP,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    method: 'POST',
    rawPath: '/api/org',
  });
  event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;
  return event;
}

function callerHolds(role: OrgRole) {
  stubMembershipRead(ddbMock, { orgId: MOCK_ORG_ID, userId: MOCK_USER_ID, role });
}

/** The one TransactWriteItems call `createAdditionalOrg` commits. */
function transactItems() {
  const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
  expect(calls).toHaveLength(1);
  return calls[0].args[0].input.TransactItems ?? [];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/org handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    mockJwtVerify.mockResolvedValue({
      payload: { sub: MOCK_SUB, email: MOCK_EMAIL, email_verified: true },
    });
    mockListMemberships.mockResolvedValue([
      { orgId: MOCK_ORG_ID, role: OrgRole.Owner, joinedAt: '' },
    ]);

    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `SUB#${MOCK_SUB}` }, sk: { S: 'IDENTITY' } },
      })
      .resolves({
        Item: {
          pk: { S: `SUB#${MOCK_SUB}` },
          sk: { S: 'IDENTITY' },
          userId: { S: MOCK_USER_ID },
          orgId: { S: MOCK_ORG_ID },
          emailEntitlementClaimed: { BOOL: true },
          profileEmail: { S: MOCK_EMAIL },
        },
      });

    ddbMock.on(TransactWriteItemsCommand).resolves({});
    // authMiddleware's own deletion-fence read of the caller's active org
    // profile — unrelated to the org this route is about to create.
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({ Item: { name: { S: 'Active Org' } } });
    callerHolds(OrgRole.Owner);
  });

  it('creates the org, owned by the caller and sourced as manual, and returns its identity', async () => {
    const result = await handler(createOrgEvent({ name: 'New Co' }), buildContext());

    expect(result.statusCode).toBe(201);
    const body = JSON.parse((result as { body: string }).body);
    const orgId: string = body.orgId;
    expect(orgId).not.toBe(MOCK_ORG_ID);
    expect(body).toEqual({ orgId, orgName: 'New Co', role: OrgRole.Owner });

    const now = expect.any(String);
    expect(transactItems()).toEqual([
      {
        Put: {
          TableName: 'UserInfoTable',
          Item: {
            pk: { S: `ORG#${orgId}` },
            sk: { S: 'PROFILE' },
            name: { S: 'New Co' },
            // Named on the way in: there is no naming step to send this org
            // through, unlike the org signup creates.
            nameConfirmed: { BOOL: true },
            auroraSetupStatus: { S: 'FILONE_ORG_CREATED' },
            createdBy: { S: MOCK_USER_ID },
            createdAt: { S: now },
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Put: {
          TableName: 'OrgTable',
          Item: { pk: { S: `ORG#${orgId}` }, sk: { S: 'META' }, ownerCount: { N: '1' } },
        },
      },
      {
        Put: {
          TableName: 'OrgTable',
          Item: {
            pk: { S: `ORG#${orgId}` },
            sk: { S: `MEMBER#${MOCK_USER_ID}` },
            role: { S: OrgRole.Owner },
            joinedAt: { S: now },
            source: { S: 'manual' },
          },
        },
      },
      {
        Put: {
          TableName: 'OrgTable',
          Item: {
            pk: { S: `USER#${MOCK_USER_ID}` },
            sk: { S: `MEMBERSHIP#${orgId}` },
            role: { S: OrgRole.Owner },
            joinedAt: { S: now },
          },
        },
      },
      {
        Put: {
          TableName: 'AuditTable',
          Item: expect.objectContaining({
            type: { S: 'org.created' },
            actor: {
              M: { kind: { S: 'user' }, id: { S: MOCK_USER_ID }, email: { S: MOCK_EMAIL } },
            },
            orgId: { S: orgId },
            details: { M: { orgName: { S: 'New Co' }, source: { S: 'manual' } } },
          }),
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
    ]);
  });

  it(`refuses a caller who already owns ${MAX_OWNED_ORGS} orgs`, async () => {
    mockListMemberships.mockResolvedValue(
      Array.from({ length: MAX_OWNED_ORGS }, (_, i) => ({
        orgId: `owned-${i}`,
        role: OrgRole.Owner,
        joinedAt: '',
      })),
    );

    const result = await handler(createOrgEvent({ name: 'New Co' }), buildContext());

    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body as string).message).toContain(`${MAX_OWNED_ORGS}`);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('does not count orgs the caller was only invited into', async () => {
    mockListMemberships.mockResolvedValue([
      ...Array.from({ length: MAX_OWNED_ORGS - 1 }, (_, i) => ({
        orgId: `owned-${i}`,
        role: OrgRole.Owner,
        joinedAt: '',
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        orgId: `joined-${i}`,
        role: OrgRole.Member,
        joinedAt: '',
      })),
    ]);

    const result = await handler(createOrgEvent({ name: 'New Co' }), buildContext());

    expect(result.statusCode).toBe(201);
  });

  it('carries no credential into the log', async () => {
    await handler(createOrgEvent({ name: 'New Co' }), buildContext());

    expectNoSecrets(auditItemIn(transactItems()));
  });

  it.each<[string, unknown]>([
    ['a name that is too short', { name: 'A' }],
    ['a name with special characters', { name: 'Acme @Corp!' }],
    ['an empty name', { name: '' }],
    ['a body with no name', {}],
    ['invalid JSON', 'not-json{'],
  ])('returns 400 for %s', async (_label, body) => {
    const result = await handler(createOrgEvent(body), buildContext());

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('refuses a caller with no membership in their own active org', async () => {
    stubAbsentMembershipRead(ddbMock, { orgId: MOCK_ORG_ID, userId: MOCK_USER_ID });

    const result = await handler(createOrgEvent({ name: 'New Co' }), buildContext());

    expect(result.statusCode).toBe(403);
  });

  it('lets a ReadOnly caller create an additional org', async () => {
    // Creating an org is not an action on the active org's resources — every
    // role may do it.
    callerHolds(OrgRole.ReadOnly);

    const result = await handler(createOrgEvent({ name: 'New Co' }), buildContext());

    expect(result.statusCode).toBe(201);
  });
});
