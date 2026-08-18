import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { AUDIT_RETENTION_DAYS, OrgRole } from '@filone/shared';
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

import { handler } from './update-org.js';
import {
  buildEvent,
  buildContext,
  NO_MEMBERSHIP,
  stubAbsentMembershipRead,
  stubMembershipRead,
} from '../test/lambda-test-utilities.js';
import { describeRoleEnforcement } from '../test/role-enforcement.js';

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

/** The rename and its audit event travel as one transaction. */
function transactItems() {
  const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
  expect(calls).toHaveLength(1);
  return calls[0].args[0].input.TransactItems ?? [];
}

function updateInput() {
  return transactItems().find((item) => item.Update)!.Update!;
}

function auditedEvent() {
  return unmarshall(auditItemIn(transactItems()));
}

/** The cancellation DynamoDB sends when the rename's own condition fails. */
function cancelledOnTheUpdate() {
  return new TransactionCanceledException({
    message: 'cancelled',
    $metadata: {},
    CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
  });
}

/** The same item cancelled by a transient, which means the write did not land. */
function cancelledByAConflict() {
  return new TransactionCanceledException({
    message: 'cancelled',
    $metadata: {},
    CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }],
  });
}

/** Every read of the org's profile row, in the order the handler made them. */
function profileReads() {
  return ddbMock
    .commandCalls(GetItemCommand)
    .filter((call) => call.args[0].input.Key?.sk?.S === 'PROFILE');
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
        },
      });

    ddbMock.on(TransactWriteItemsCommand).resolves({});
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
      ExpressionAttributeValues: { ':name': { S: 'New Corp' }, ':previousName': { S: 'Old Corp' } },
      // Never conjure an org, and never record a transition that did not
      // happen: the write is conditional on the name the event names.
      ConditionExpression: 'attribute_exists(pk) AND #name = :previousName',
    });
  });

  it('writes nothing when the submitted name is the one the org already has', async () => {
    // The Settings page submits the form whether or not the field changed, and
    // an event saying an org was renamed from "Old Corp" to "Old Corp" is noise
    // in a log a customer reads.
    const result = await handler(renameEvent({ name: 'Old Corp' }), buildContext());

    expect(result).toMatchObject({ statusCode: 200, body: JSON.stringify({ name: 'Old Corp' }) });
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('carries no credential into the log', async () => {
    await handler(renameEvent({ name: 'New Corp' }), buildContext());

    expectNoSecrets(auditItemIn(transactItems()));
  });

  it('records the rename beside the write, with both names', async () => {
    await handler(renameEvent({ name: 'New Corp' }), buildContext());

    const items = transactItems();
    expect(items).toHaveLength(2);
    expect(items.find((item) => item.Put?.TableName === 'AuditTable')!.Put).toMatchObject({
      TableName: 'AuditTable',
      // Append-only: an event id already on the table cancels the whole
      // transaction rather than rewriting history.
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect(auditedEvent()).toMatchObject({
      pk: `ORG#${MOCK_ORG_ID}`,
      type: 'org.renamed',
      orgId: MOCK_ORG_ID,
      subject: `org:${MOCK_ORG_ID}`,
      actor: { kind: 'user', id: MOCK_USER_ID, email: MOCK_EMAIL },
      details: { previousName: 'Old Corp', name: 'New Corp' },
    });
  });

  it('stamps the event to expire 90 days out', async () => {
    await handler(renameEvent({ name: 'New Corp' }), buildContext());

    const event = auditedEvent();
    const expected =
      Math.floor(Date.parse(event.createdAt) / 1000) + AUDIT_RETENTION_DAYS * 24 * 60 * 60;
    expect(event.ttl).toBe(expected);
  });

  it('reads the previous name rather than asking the write for it', async () => {
    // `UPDATED_OLD` returns nothing when the attribute was absent, and an org
    // created before naming shipped has no `name` on its profile row — the
    // audit event would record a rename with no predecessor. The read is also
    // what lets a TransactWriteItems wrap the write with the audit record.
    orgProfileNamed(undefined);

    const result = await handler(renameEvent({ name: 'New Corp' }), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(updateInput()).toMatchObject({
      ExpressionAttributeNames: { '#name': 'name' },
      // Nothing to match, so the condition says the attribute is still absent.
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#name)',
    });
    expect(updateInput().ExpressionAttributeValues).not.toHaveProperty(':previousName');
    expect(auditedEvent().details).toStrictEqual({ name: 'New Corp' });
  });

  it('leaves the org unrenamed when the event cannot be written', async () => {
    // The ADR accepts this: an AuditTable outage blocks the control-plane
    // write rather than letting a rename land unrecorded.
    ddbMock.on(TransactWriteItemsCommand).rejects(new Error('AuditTable unavailable'));

    const result = await handler(renameEvent({ name: 'New Corp' }), buildContext());

    expect(result).toMatchObject({ statusCode: 500 });
  });

  it('returns 404 when the profile row the rename is conditional on is gone', async () => {
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledOnTheUpdate());
    orgProfileNamed(undefined);
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({});

    const result = await handler(renameEvent({ name: 'New Corp' }), buildContext());

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 409 when someone else renamed the org first', async () => {
    // The condition covers the previous name as well as the row, so the same
    // cancellation means two different things — and telling a caller the org
    // does not exist when it was simply renamed under them is a lie.
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledOnTheUpdate());

    const result = await handler(renameEvent({ name: 'New Corp' }), buildContext());

    expect(result).toMatchObject({ statusCode: 409 });
    expect(JSON.parse((result as { body: string }).body).message).toStrictEqual(
      expect.stringContaining('renamed by someone else'),
    );
  });

  it('does not answer a transient cancellation with a conflict', async () => {
    // A TransactionConflict cancels the same item and means the opposite of a
    // failed condition: the write did not happen, and telling the caller the
    // org was renamed under them states something untrue about a failure they
    // could retry.
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledByAConflict());

    const result = await handler(renameEvent({ name: 'New Corp' }), buildContext());

    expect(result).toMatchObject({ statusCode: 500 });
    // The conflict path never ran: only the rename's own read touched the
    // profile row.
    expect(profileReads()).toHaveLength(1);
  });

  it('reads the profile row consistently before calling the org gone', async () => {
    // The rename already proved the row existed on the leader milliseconds
    // ago, so a stale replica answering this read would report a live org as
    // deleted.
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledOnTheUpdate());

    await handler(renameEvent({ name: 'New Corp' }), buildContext());

    expect(profileReads()).toHaveLength(2);
    expect(profileReads().every((call) => call.args[0].input.ConsistentRead === true)).toBe(true);
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
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
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

  describeRoleEnforcement({
    permission: 'org.rename',
    orgId: MOCK_ORG_ID,
    userId: MOCK_USER_ID,
    invoke: (membership) => {
      // The real chain runs, so the role comes from the OrgTable row rather
      // than from the event.
      if (membership === NO_MEMBERSHIP) {
        stubAbsentMembershipRead(ddbMock, { orgId: MOCK_ORG_ID, userId: MOCK_USER_ID });
      } else {
        callerHolds(membership.role);
      }
      return handler(renameEvent({ name: 'New Corp' }), buildContext());
    },
  });
});
