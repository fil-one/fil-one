import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { OrgRole } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';
import { auditItemIn, expectNoSecrets } from '../test/audit-assertions.js';

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

const ddbMock = mockClient(DynamoDBClient);

process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.com';

import { handler } from './create-org.js';
import { OrgKeys } from '../lib/org-membership.js';
import {
  buildEvent,
  buildContext,
  NO_MEMBERSHIP,
  stubAbsentMembershipRead,
  stubMembershipRead,
} from '../test/lambda-test-utilities.js';

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

function profilePut() {
  return transactItems().find((item) => item.Put?.TableName === 'UserInfoTable')!.Put!;
}

function auditedEvent() {
  return unmarshall(auditItemIn(transactItems()));
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
    // The slug probe's default answer: nothing is claimed yet.
    ddbMock.on(GetItemCommand, { TableName: 'OrgTable' }).resolves({});
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

  it('creates the org and returns its identity', async () => {
    const result = await handler(createOrgEvent({ name: 'New Co' }), buildContext());

    expect(result.statusCode).toBe(201);
    const body = JSON.parse((result as { body: string }).body);
    expect(body).toMatchObject({
      orgName: 'New Co',
      // Random and opaque, not derived from the name — see `org-slug.ts`.
      slug: expect.any(String),
      role: OrgRole.Owner,
    });
    expect(typeof body.orgId).toBe('string');
    expect(body.orgId).not.toBe(MOCK_ORG_ID);
  });

  it('writes a profile row confirmed and owned by the caller, not the naming flow', async () => {
    await handler(createOrgEvent({ name: 'New Co' }), buildContext());

    expect(profilePut()).toMatchObject({
      TableName: 'UserInfoTable',
      Item: {
        sk: { S: 'PROFILE' },
        name: { S: 'New Co' },
        slug: { S: expect.any(String) },
        // Named on the way in — there is no naming step to send this org
        // through, unlike the org signup creates.
        nameConfirmed: { BOOL: true },
        createdBy: { S: MOCK_USER_ID },
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('makes the caller the Owner, sourced as a manual creation', async () => {
    await handler(createOrgEvent({ name: 'New Co' }), buildContext());

    const items = transactItems();
    // The canonical membership row: OrgTable, sort key MEMBER#{userId}.
    const member = items.find(
      (item) =>
        item.Put?.TableName === 'OrgTable' &&
        item.Put.Item?.sk?.S === OrgKeys.memberSk(MOCK_USER_ID),
    )!.Put!;

    expect(member.Item).toMatchObject({
      role: { S: OrgRole.Owner },
      source: { S: 'manual' },
    });
  });

  it('carries the logo URL through when one is provided', async () => {
    const result = await handler(
      createOrgEvent({
        name: 'New Co',
        logoUrl: 'https://OrgLogoBucket.s3.us-east-1.amazonaws.com/logos/abc.png',
      }),
      buildContext(),
    );

    const body = JSON.parse((result as { body: string }).body);
    expect(body.logoUrl).toBe('https://OrgLogoBucket.s3.us-east-1.amazonaws.com/logos/abc.png');
    expect(profilePut().Item).toMatchObject({
      logoUrl: { S: 'https://OrgLogoBucket.s3.us-east-1.amazonaws.com/logos/abc.png' },
    });
  });

  it('omits the logo field entirely when none is given', async () => {
    const result = await handler(createOrgEvent({ name: 'New Co' }), buildContext());

    const body = JSON.parse((result as { body: string }).body);
    expect(body).not.toHaveProperty('logoUrl');
    expect(profilePut().Item).not.toHaveProperty('logoUrl');
  });

  it('rejects a logo URL that did not come from the upload endpoint', async () => {
    const result = await handler(
      createOrgEvent({ name: 'New Co', logoUrl: 'https://attacker.example/tracker.png' }),
      buildContext(),
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('records an org.created event distinct from a signup', async () => {
    await handler(createOrgEvent({ name: 'New Co' }), buildContext());

    expect(auditedEvent()).toMatchObject({
      type: 'org.created',
      actor: { kind: 'user', id: MOCK_USER_ID, email: MOCK_EMAIL },
      details: { orgName: 'New Co', source: 'manual' },
    });
  });

  it('carries no credential into the log', async () => {
    await handler(createOrgEvent({ name: 'New Co' }), buildContext());

    expectNoSecrets(auditItemIn(transactItems()));
  });

  it('writes the inverse membership item so the switcher can find the org', async () => {
    await handler(createOrgEvent({ name: 'New Co' }), buildContext());

    const items = transactItems();
    const inverse = items.find(
      (item) =>
        item.Put?.TableName === 'OrgTable' &&
        item.Put.Item?.pk?.S === OrgKeys.userPk(MOCK_USER_ID) &&
        OrgKeys.parseMembershipSk(item.Put.Item?.sk?.S ?? ''),
    );
    expect(inverse).toBeDefined();
  });

  it.each([
    ['too short', 'A'],
    ['special characters', 'Acme @Corp!'],
    ['empty', ''],
  ])('returns 400 for a name that is %s', async (_label, name) => {
    const result = await handler(createOrgEvent({ name }), buildContext());

    expect(result.statusCode).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('returns 400 for a body with no name', async () => {
    const result = await handler(createOrgEvent({}), buildContext());

    expect(result.statusCode).toBe(400);
  });

  it('returns 400 for invalid JSON', async () => {
    const result = await handler(createOrgEvent('not-json{'), buildContext());

    expect(result.statusCode).toBe(400);
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
