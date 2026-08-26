import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { OrgRole } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';

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

import { handler } from './update-org.js';
import {
  buildEvent,
  buildContext,
  NO_MEMBERSHIP,
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

/**
 * The real chain, cookies and all: this route's point is that `authorize` sees
 * the role the membership row carries, so the row has to be read rather than
 * handed over in the event.
 */
function renameEvent(body: unknown) {
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
      // Nothing stamped here: the real auth middleware runs and reads the row.
      membership: NO_MEMBERSHIP,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    method: 'PATCH',
    rawPath: '/api/org',
  });
  event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;
  return event;
}

function callerHolds(role: OrgRole) {
  stubMembershipRead(ddbMock, { orgId: MOCK_ORG_ID, userId: MOCK_USER_ID, role });
}

function updateInput() {
  const calls = ddbMock.commandCalls(UpdateItemCommand);
  expect(calls).toHaveLength(1);
  return calls[0].args[0].input;
}

/** Answer the profile-row read the rename makes to capture the previous name. */
function orgProfileNamed(name?: string) {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
    })
    .resolves(name === undefined ? {} : { Item: { name: { S: name } } });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PATCH /api/org handler', () => {
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
          // A returning caller, whose profile already holds the address this
          // session proves. Without the marker the login path stamps it on the
          // way in, and the updates this suite counts would not all be the
          // rename's.
          profileEmail: { S: MOCK_EMAIL },
        },
      });

    ddbMock.on(UpdateItemCommand).resolves({});
    orgProfileNamed('Old Corp');
    callerHolds(OrgRole.Owner);
  });

  it('renames the org', async () => {
    const result = await handler(renameEvent({ name: 'New Corp' }), buildContext());

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ name: 'New Corp' }),
    });
    expect(updateInput()).toMatchObject({
      TableName: 'UserInfoTable',
      Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
      ExpressionAttributeValues: { ':name': { S: 'New Corp' } },
      // Never conjure an org: a rename that finds no profile row fails.
      ConditionExpression: 'attribute_exists(pk)',
    });
  });

  it('reads the previous name, which the audit event will need, and stamps the event', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handler(renameEvent({ name: 'New Corp' }), buildContext());

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('org.renamed'),
      expect.objectContaining({
        orgId: MOCK_ORG_ID,
        actorUserId: MOCK_USER_ID,
        previousName: 'Old Corp',
        name: 'New Corp',
      }),
    );
  });

  it('reads the previous name rather than asking the write for it', async () => {
    // `UPDATED_OLD` returns nothing when the attribute was absent, and an org
    // created before naming shipped has no `name` on its profile row — the
    // audit event would record a rename with no predecessor. The read is also
    // what lets a TransactWriteItems wrap the write with the audit record.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    orgProfileNamed(undefined);

    const result = await handler(renameEvent({ name: 'New Corp' }), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(updateInput().ReturnValues).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('org.renamed'),
      expect.objectContaining({ previousName: undefined, name: 'New Corp' }),
    );
  });

  it('returns 404 when the profile row the rename is conditional on is gone', async () => {
    ddbMock
      .on(UpdateItemCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'conditional', $metadata: {} }));

    const result = await handler(renameEvent({ name: 'New Corp' }), buildContext());

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('escapes the stored name', async () => {
    await handler(renameEvent({ name: 'Acme-Corp Inc.' }), buildContext());

    expect(updateInput()).toMatchObject({
      ExpressionAttributeValues: { ':name': { S: 'Acme-Corp Inc.' } },
    });
  });

  it('lets an Admin rename the org', async () => {
    callerHolds(OrgRole.Admin);

    const result = await handler(renameEvent({ name: 'New Corp' }), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
  });

  it.each([
    ['too short', 'A'],
    ['special characters', 'Acme @Corp!'],
    ['empty', ''],
  ])('returns 400 for a name that is %s', async (_label, name) => {
    const result = await handler(renameEvent({ name }), buildContext());

    expect(result).toMatchObject({ statusCode: 400 });
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('answers a rejected name with the rule the form has to state', async () => {
    // The console shows this string under the field, so a generic "invalid
    // request" would leave the user guessing which characters are allowed.
    const result = await handler(renameEvent({ name: 'Acme @Corp!' }), buildContext());

    expect(JSON.parse((result as { body: string }).body).message).toStrictEqual(
      expect.stringContaining('letters, numbers, spaces, hyphens, and periods'),
    );
  });

  it('returns 400 for a body with no name', async () => {
    const result = await handler(renameEvent({}), buildContext());

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 for invalid JSON', async () => {
    const result = await handler(renameEvent('not-json{'), buildContext());

    expect(result).toMatchObject({ statusCode: 400 });
  });
});
