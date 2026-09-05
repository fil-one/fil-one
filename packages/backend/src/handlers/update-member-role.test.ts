import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { ApiErrorCode, OrgRole, S3Region, Stage } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';
import { auditItemIn, expectNoSecrets } from '../test/audit-assertions.js';

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

// The handler revokes keys at whichever orchestrator holds them, and the
// registry builds the FTH client at import time from a secret this suite has
// no reason to stand up.
const mockDeleteAccessKey = vi.fn();
vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getOrchestratorForRegion: (region: string) => ({
    id: region === 'us-east-1' ? 'fth' : 'aurora',
    region,
    accessModel: 'scoped-keys',
    isTenantReady: () => `tenant:${region}`,
    deleteAccessKey: (...args: unknown[]) => mockDeleteAccessKey(...args),
  }),
}));

const ddbMock = mockClient(DynamoDBClient);

// The revocation email is the only thing here that leaves over HTTP.
const mockFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.com';

import { handler } from './update-member-role.js';
import { OrgKeys } from '../lib/org-membership.js';
import { inviteExpiresAt } from '../lib/invitations.js';
import {
  buildEvent,
  buildContext,
  NO_MEMBERSHIP,
  stubAbsentMembershipRead,
  stubMembershipRead,
} from '../test/lambda-test-utilities.js';

const MOCK_SUB = 'auth0|owner';
const ORG_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = 'caller-user-id';
const TARGET_ID = 'target-user-id';
const EMAIL = 'owner@example.com';
const MOCK_CSRF_TOKEN = 'csrf-token-value';

function roleEvent(role: unknown = OrgRole.Admin, targetUserId: string | null = TARGET_ID) {
  const event = buildEvent({
    cookies: [
      `hs_access_token=valid-token`,
      `hs_id_token=id-token`,
      `hs_csrf_token=${MOCK_CSRF_TOKEN}`,
    ],
    userInfo: { userId: USER_ID, orgId: ORG_ID, email: EMAIL, membership: NO_MEMBERSHIP },
    body: typeof role === 'string' && role.startsWith('{') ? role : JSON.stringify({ role }),
    method: 'PATCH',
    rawPath: `/api/org/members/${targetUserId ?? ''}`,
  });
  event.headers['x-csrf-token'] = MOCK_CSRF_TOKEN;
  if (targetUserId) {
    (event as { pathParameters?: Record<string, string> }).pathParameters = {
      userId: targetUserId,
    };
  }
  return event;
}

function callerHolds(role: OrgRole) {
  stubMembershipRead(ddbMock, { orgId: ORG_ID, userId: USER_ID, role });
}

function targetHolds(role: OrgRole | undefined) {
  if (!role) {
    stubAbsentMembershipRead(ddbMock, { orgId: ORG_ID, userId: TARGET_ID });
    return;
  }
  stubMembershipRead(ddbMock, { orgId: ORG_ID, userId: TARGET_ID, role });
}

/** The pending invitations the target issued, which a demotion sweeps. */
function stubTargetInvitations(...roles: OrgRole[]) {
  ddbMock
    .on(QueryCommand, {
      TableName: 'OrgTable',
      ExpressionAttributeValues: {
        ':pk': { S: OrgKeys.orgPk(ORG_ID) },
        ':skPrefix': { S: 'INVITE#' },
      },
    })
    .resolves({
      Items: roles.map((role, index) => ({
        pk: { S: OrgKeys.orgPk(ORG_ID) },
        sk: { S: OrgKeys.inviteSk(`invite-${role}-${index}`) },
        email: { S: `person-${index}@example.com` },
        emailNorm: { S: `person-${index}@example.com` },
        role: { S: role },
        invitedBy: { S: TARGET_ID },
        status: { S: 'pending' },
        createdAt: { S: '2026-08-14T00:00:00.000Z' },
        expiresAt: { S: inviteExpiresAt(new Date().toISOString()) },
        tokenHash: { S: `${index}`.repeat(64).slice(0, 64) },
      })),
    });
}

/** The org's PROFILE row, which the revocation pass resolves tenants from. */
function stubOrgProfile(orgName = 'Acme Storage') {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'PROFILE' } },
    })
    .resolves({
      Item: {
        pk: { S: `ORG#${ORG_ID}` },
        sk: { S: 'PROFILE' },
        name: { S: orgName },
        auroraTenantId: { S: 'aurora-tenant' },
      },
    });
}

/** The target's access keys, as the org partition holds them. */
function stubMemberKeys(...keys: Array<Record<string, unknown>>) {
  ddbMock
    .on(QueryCommand, {
      TableName: 'UserInfoTable',
      ExpressionAttributeValues: {
        ':pk': { S: `ORG#${ORG_ID}` },
        ':skPrefix': { S: 'ACCESSKEY#' },
      },
    })
    .resolves({
      Items: keys.map((key, index) =>
        marshall(
          {
            pk: `ORG#${ORG_ID}`,
            sk: `ACCESSKEY#key-${index}`,
            keyName: `key ${index}`,
            accessKeyId: `AKIAEXAMPLE000${index}`,
            createdAt: '2026-02-01T00:00:00.000Z',
            status: 'active',
            region: S3Region.UsEast1,
            createdBy: TARGET_ID,
            ...key,
          },
          { removeUndefinedValues: true },
        ),
      ),
    });
}

/**
 * The org's META row, which the failure path reads to tell the last-Owner guard
 * firing from there being no counter for it to fire on.
 */
function stubOwnerCount(ownerCount: number | undefined) {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'OrgTable',
      Key: { pk: { S: OrgKeys.orgPk(ORG_ID) }, sk: { S: 'META' } },
    })
    .resolves(
      ownerCount === undefined
        ? {}
        : {
            Item: {
              pk: { S: OrgKeys.orgPk(ORG_ID) },
              sk: { S: 'META' },
              ownerCount: { N: String(ownerCount) },
            },
          },
    );
}

function transactItems() {
  const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
  expect(calls).toHaveLength(1);
  return calls[0].args[0].input.TransactItems ?? [];
}

/** One transaction out of several, when a revocation pass wrote its own. */
function transactItemsAt(index: number) {
  const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
  return calls.at(index)?.args[0].input.TransactItems ?? [];
}

function counterItem() {
  return transactItems().find((item) => item.Update?.Key?.sk?.S === 'META')?.Update;
}

function body(result: unknown) {
  return JSON.parse((result as { body: string }).body);
}

function cancelledAt(index: number, itemCount: number) {
  return new TransactionCanceledException({
    message: 'cancelled',
    $metadata: {},
    CancellationReasons: Array.from({ length: itemCount }, (_unused, position) => ({
      Code: position === index ? 'ConditionalCheckFailed' : 'None',
    })),
  });
}

describe('PATCH /api/org/members/{userId} handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    mockJwtVerify.mockResolvedValue({
      payload: { sub: MOCK_SUB, email: EMAIL, email_verified: true },
    });

    ddbMock.on(GetItemCommand).resolves({});
    // The org partition the revocation pass reads. Most cases hold no keys.
    ddbMock.on(QueryCommand).resolves({ Items: [] });
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

    ddbMock.on(TransactWriteItemsCommand).resolves({});
    stubTargetInvitations();
    // Two Owners by default: the handler reads the counter before it revokes
    // anything, so a sole Owner is refused before a key is touched and the
    // cases below never reach the transaction.
    stubOwnerCount(2);
    stubOrgProfile();
    callerHolds(OrgRole.Owner);
    targetHolds(OrgRole.Member);
  });

  it('moves a member to another role, on both rows', async () => {
    const result = await handler(roleEvent(OrgRole.Admin), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(body(result)).toStrictEqual({
      userId: TARGET_ID,
      role: OrgRole.Admin,
      previousRole: OrgRole.Member,
    });

    const items = transactItems();
    // fence, canonical, inverse, event — the owner set did not move.
    expect(items).toHaveLength(4);
    const canonical = items.find(
      (item) => item.Update?.Key?.sk?.S === OrgKeys.memberSk(TARGET_ID),
    )!.Update!;
    expect(canonical).toMatchObject({
      ConditionExpression: 'attribute_exists(pk) AND #role = :fromRole',
      ExpressionAttributeValues: {
        ':role': { S: OrgRole.Admin },
        ':fromRole': { S: OrgRole.Member },
      },
    });
    expect(items.some((item) => item.Update?.Key?.pk?.S === OrgKeys.userPk(TARGET_ID))).toBe(true);
  });

  it('records the change with no secret in it', async () => {
    await handler(roleEvent(OrgRole.Admin), buildContext());

    expect(unmarshall(auditItemIn(transactItems()))).toMatchObject({
      type: 'member.role_changed',
      orgId: ORG_ID,
      subject: `user:${TARGET_ID}`,
      actor: { kind: 'user', id: USER_ID, email: EMAIL },
      details: { role: OrgRole.Admin, previousRole: OrgRole.Member },
    });
    expectNoSecrets(auditItemIn(transactItems()));
  });

  it('raises the owner count on a promotion to Owner', async () => {
    const result = await handler(roleEvent(OrgRole.Owner), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(counterItem()).toMatchObject({
      UpdateExpression: 'SET ownerCount = ownerCount + :one ADD ownerSetRev :one',
      ConditionExpression: 'attribute_exists(ownerCount)',
    });
  });

  it('guards the decrement with the condition that is the last-Owner invariant', async () => {
    targetHolds(OrgRole.Owner);
    // The handler reads the counter before it revokes anything, so an org with
    // a second Owner is what lets the change reach the transaction at all.
    stubOwnerCount(2);

    const result = await handler(roleEvent(OrgRole.Admin), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(counterItem()).toMatchObject({
      UpdateExpression: 'SET ownerCount = ownerCount - :one ADD ownerSetRev :one',
      // DynamoDB permits one operation per item per transaction, so the check
      // and the decrement have to be the same operation.
      ConditionExpression: 'ownerCount > :one',
    });
  });

  it('refuses to demote the last Owner', async () => {
    targetHolds(OrgRole.Owner);
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt(3, 5));

    const result = await handler(roleEvent(OrgRole.Admin), buildContext());

    expect(result).toMatchObject({ statusCode: 409 });
    expect(body(result).code).toBe(ApiErrorCode.LAST_OWNER);
  });

  it('does not call an Owner the last one when there is no counter to read', async () => {
    // The decrement conditions on `ownerCount`, so a missing META row cancels
    // the same item for the opposite reason: the guard was never armed. The
    // remedy is support and the drift checker, not promoting somebody.
    targetHolds(OrgRole.Owner);
    stubOwnerCount(undefined);
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt(3, 5));

    const result = await handler(roleEvent(OrgRole.Admin), buildContext());

    expect(result).toMatchObject({ statusCode: 409 });
    expect(body(result).code).toBeUndefined();
    expect(body(result).message).toStrictEqual(expect.stringContaining('contact support'));
    expect(console.error).toHaveBeenCalled();
  });

  it('reports a transient conflict as a failure rather than a verdict', async () => {
    // A TransactionConflict cancels an item exactly as a failed condition does.
    // Read as the guard firing, it would tell an Owner they are the last one.
    targetHolds(OrgRole.Owner);
    ddbMock.on(TransactWriteItemsCommand).rejects(
      new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [
          { Code: 'None' },
          { Code: 'None' },
          { Code: 'None' },
          { Code: 'TransactionConflict' },
          { Code: 'None' },
        ],
      }),
    );

    const result = await handler(roleEvent(OrgRole.Admin), buildContext());

    expect(result).toMatchObject({ statusCode: 500 });
  });

  it('refuses an Admin promoting anyone to Owner', async () => {
    callerHolds(OrgRole.Admin);

    const result = await handler(roleEvent(OrgRole.Owner), buildContext());

    expect(result).toMatchObject({ statusCode: 403 });
    expect(body(result).code).toBe(ApiErrorCode.FORBIDDEN_ROLE);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('refuses an Admin demoting an Owner', async () => {
    // A role change is two reaches — at the member as they are and as they
    // would be — and both have to clear the ceiling.
    callerHolds(OrgRole.Admin);
    targetHolds(OrgRole.Owner);

    const result = await handler(roleEvent(OrgRole.Member), buildContext());

    expect(result).toMatchObject({ statusCode: 403 });
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('writes nothing when the role is the one they already hold', async () => {
    const result = await handler(roleEvent(OrgRole.Member), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('returns 404 for somebody who is not a member', async () => {
    targetHolds(undefined);

    const result = await handler(roleEvent(OrgRole.Admin), buildContext());

    expect(result).toMatchObject({ statusCode: 404 });
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('revokes only the invitations the new role could no longer issue', async () => {
    // Owner → Admin keeps members.manage and loses owners.manage, so their
    // Owner invitation goes and their Member invitation stays.
    targetHolds(OrgRole.Owner);
    stubTargetInvitations(OrgRole.Owner, OrgRole.Member);

    await handler(roleEvent(OrgRole.Admin), buildContext());

    const items = transactItems();
    const revocations = items.filter(
      (item) => item.Update?.UpdateExpression === 'SET #status = :status',
    );
    expect(revocations).toHaveLength(1);
    expect(revocations[0].Update).toMatchObject({
      ConditionExpression: '#status = :pending',
      ExpressionAttributeValues: { ':status': { S: 'revoked' }, ':pending': { S: 'pending' } },
    });
    expect(items.filter((item) => item.Delete)).toHaveLength(1);
    expect(unmarshall(auditItemIn(items)).details).toMatchObject({ revokedInvitations: 1 });
  });

  it('revokes both when the new role can issue neither', async () => {
    targetHolds(OrgRole.Owner);
    stubTargetInvitations(OrgRole.Owner, OrgRole.Member);

    await handler(roleEvent(OrgRole.ReadOnly), buildContext());

    expect(
      transactItems().filter((item) => item.Update?.UpdateExpression === 'SET #status = :status'),
    ).toHaveLength(2);
    expect(unmarshall(auditItemIn(transactItems())).details).toMatchObject({
      revokedInvitations: 2,
    });
  });

  it('loses cleanly to a role change that landed first', async () => {
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt(1, 4));

    const result = await handler(roleEvent(OrgRole.Admin), buildContext());

    expect(result).toMatchObject({ statusCode: 409 });
  });

  it('fences the transaction on the org not being deleted, as item 0', async () => {
    // The inverse item's update is unconditional so it repairs a copy that had
    // drifted, which also means it RECREATES one the teardown has already
    // deleted — the scrub takes the inverse items before the canonical rows.
    // Conditioning the inverse on the canonical row is not available: DynamoDB
    // permits one operation per item per transaction and the canonical row
    // already carries the Update.
    await handler(roleEvent(OrgRole.Admin), buildContext());

    expect(transactItems()[0].ConditionCheck).toMatchObject({
      TableName: 'UserInfoTable',
      Key: { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'PROFILE' } },
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(deleting)',
    });
  });

  it('answers account-deleted when the org is being torn down', async () => {
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt(0, 4));

    const result = await handler(roleEvent(OrgRole.Admin), buildContext());

    expect(result).toMatchObject({ statusCode: 410 });
    expect(body(result).code).toBe(ApiErrorCode.ACCOUNT_DELETED);
  });

  it.each([
    ['a role that is not one of the four', 'billing'],
    ['no role at all', '{}'],
    ['invalid JSON', 'not-json{'],
  ])('returns 400 for %s', async (_label, role) => {
    const result = await handler(roleEvent(role), buildContext());

    expect(result).toMatchObject({ statusCode: 400 });
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('returns 400 with no member id in the path', async () => {
    const result = await handler(roleEvent(OrgRole.Admin, null), buildContext());

    expect(result).toMatchObject({ statusCode: 400 });
  });
});

/**
 * A key carries its own permission set, stamped when it was minted, and nothing
 * at Aurora or FTH evaluates it against the role its holder now has. So a
 * narrowing revokes the keys the new role could not mint, at the vendor, before
 * the role is written: a member is never wider at a storage vendor than the
 * role the console records for them.
 */
describe('a narrowing revokes the keys the new role could not mint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockJwtVerify.mockResolvedValue({
      payload: { sub: MOCK_SUB, email: EMAIL, email_verified: true },
    });

    ddbMock.on(GetItemCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });
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

    ddbMock.on(TransactWriteItemsCommand).resolves({});
    stubTargetInvitations();
    stubOwnerCount(2);
    stubOrgProfile();
    callerHolds(OrgRole.Owner);
    targetHolds(OrgRole.Admin);
    mockDeleteAccessKey.mockResolvedValue(undefined);
    delete process.env.FILONE_STAGE;
  });

  afterEach(() => {
    delete process.env.FILONE_STAGE;
  });

  it('revokes the key that exceeds the new role and leaves the one that does not', async () => {
    stubMemberKeys(
      { permissions: ['read', 'DeleteBucket'] },
      { permissions: ['read', 'write'] },
      { permissions: ['read'], createdBy: 'somebody-else' },
    );

    const result = await handler(roleEvent(OrgRole.Member), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(body(result).revokedKeys).toStrictEqual([
      {
        id: 'key-0',
        keyName: 'key 0',
        accessKeyIdSuffix: '0000',
        region: S3Region.UsEast1,
        createdAt: '2026-02-01T00:00:00.000Z',
        reason: 'exceeds_role',
        excess: ['DeleteBucket'],
      },
    ]);
    expect(mockDeleteAccessKey.mock.calls).toStrictEqual([['tenant:us-east-1', 'key-0']]);
  });

  it('revokes at the vendor before it writes the role', async () => {
    stubMemberKeys({ permissions: ['read', 'DeleteBucket'] });
    const order: string[] = [];
    mockDeleteAccessKey.mockImplementation(() => {
      order.push('revoke');
      return Promise.resolve();
    });
    ddbMock.on(TransactWriteItemsCommand).callsFake(() => {
      order.push('transaction');
      return {};
    });

    await handler(roleEvent(OrgRole.Member), buildContext());

    // The first transaction after the revocation is the role write; the ones
    // before it are each revocation's own completion.
    expect(order.indexOf('revoke')).toBeLessThan(order.lastIndexOf('transaction'));
    expect(order[0]).toBe('revoke');
  });

  it('takes every key a member had when they are demoted to ReadOnly', async () => {
    stubMemberKeys({ permissions: ['read'] }, { permissions: ['write'] });

    const result = await handler(roleEvent(OrgRole.ReadOnly), buildContext());

    expect(
      body(result).revokedKeys.map((key: { id: string; reason: string }) => key.reason),
    ).toStrictEqual(['role_cannot_mint', 'role_cannot_mint']);
  });

  it('leaves the role unchanged when a vendor refuses, and names what already went', async () => {
    stubMemberKeys(
      { permissions: ['read', 'DeleteBucket'] },
      { permissions: ['DeleteBucket'], region: S3Region.EuWest1 },
    );
    mockDeleteAccessKey.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('down'));

    const result = await handler(roleEvent(OrgRole.Member), buildContext());

    expect(result).toMatchObject({ statusCode: 502 });
    expect(body(result).revokedKeys.map((key: { id: string }) => key.id)).toStrictEqual(['key-0']);
    expect(body(result).failedKeys.map((key: { id: string }) => key.id)).toStrictEqual(['key-1']);
    // The role write never ran: the only transactions are the completed
    // revocation's own.
    expect(
      ddbMock
        .commandCalls(TransactWriteItemsCommand)
        .flatMap((call) => call.args[0].input.TransactItems ?? [])
        .filter((item) => item.Update?.UpdateExpression === 'SET #role = :role'),
    ).toHaveLength(0);
  });

  it('refuses a sole Owner before a key is touched', async () => {
    // A revocation cannot be undone, so every local precondition that can
    // refuse the change is checked first.
    targetHolds(OrgRole.Owner);
    stubOwnerCount(1);
    stubMemberKeys({ permissions: ['read', 'DeleteBucket'] });

    const result = await handler(roleEvent(OrgRole.Admin), buildContext());

    expect(result).toMatchObject({ statusCode: 409 });
    expect(body(result).code).toBe(ApiErrorCode.LAST_OWNER);
    expect(mockDeleteAccessKey).not.toHaveBeenCalled();
  });

  it('refuses a decrement with no counter to read, before a key is touched', async () => {
    // The decrement conditions on `ownerCount`, so a missing META row cancels
    // the transaction just the same. Revoking first would leave the role
    // unchanged and the credentials gone.
    targetHolds(OrgRole.Owner);
    stubOwnerCount(undefined);
    stubMemberKeys({ permissions: ['read', 'DeleteBucket'] });

    const result = await handler(roleEvent(OrgRole.Admin), buildContext());

    expect(result).toMatchObject({ statusCode: 409 });
    expect(body(result).message).toContain('owner count');
    expect(mockDeleteAccessKey).not.toHaveBeenCalled();
  });

  it('tells the member about keys that went before the change was refused', async () => {
    // The role is unchanged, but those credentials are gone and their clients
    // are already broken. Nothing else reaches them.
    process.env.FILONE_STAGE = Stage.Production;
    mockFetch.mockResolvedValue(new Response('', { status: 202 }));
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `USER#${TARGET_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({ Item: { email: { S: 'member@example.com' } } });
    stubMemberKeys({ permissions: ['read', 'DeleteBucket'] }, { permissions: ['DeleteBucket'] });
    mockDeleteAccessKey.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('down'));

    const result = await handler(roleEvent(OrgRole.Member), buildContext());

    expect(result).toMatchObject({ statusCode: 502 });
    const sent = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as {
      content: Array<{ value: string }>;
    };
    expect(sent.content[0]!.value).toContain('key 0');
    // Not a role change, because the role did not change.
    expect(sent.content[0]!.value).not.toContain('changed from');
    expect(sent.content[0]!.value).toContain('did not complete');
  });

  it('records the pair, the ids on the completion and one event per key', async () => {
    stubMemberKeys({ permissions: ['read', 'DeleteBucket'] });

    await handler(roleEvent(OrgRole.Member), buildContext());

    const standalone = ddbMock
      .commandCalls(PutItemCommand)
      .map((call) => unmarshall(call.args[0].input.Item ?? {}));
    const roleIntent = standalone.find((event) => event.type === 'member.role_changed');
    expect(roleIntent).toMatchObject({ phase: 'intent', details: { role: OrgRole.Member } });

    const committed = ddbMock
      .commandCalls(TransactWriteItemsCommand)
      .map((call) => unmarshall(auditItemIn(call.args[0].input.TransactItems)));
    const revocation = committed.find((event) => event.type === 'key.deleted');
    const completion = committed.find((event) => event.type === 'member.role_changed');

    expect(revocation).toMatchObject({
      phase: 'completion',
      outcome: 'succeeded',
      details: { reason: 'role_narrowing', keyIdSuffix: '0000' },
    });
    expect(completion).toMatchObject({
      phase: 'completion',
      outcome: 'succeeded',
      correlationId: roleIntent!.correlationId,
      details: { revokedKeys: ['key-0'] },
    });
    expectNoSecrets(auditItemIn(transactItemsAt(-1)));
  });

  it('stays one event when the narrowing finds no key to revoke', async () => {
    const result = await handler(roleEvent(OrgRole.Member), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(body(result)).not.toHaveProperty('revokedKeys');
    expect(
      ddbMock
        .commandCalls(PutItemCommand)
        .map((call) => unmarshall(call.args[0].input.Item ?? {}))
        .filter((event) => event.type === 'member.role_changed'),
    ).toStrictEqual([]);
  });

  it('reads no keys at all on a promotion', async () => {
    // A widening strands nothing, and a key row nobody can describe should not
    // be revoked by a change that takes nothing away.
    targetHolds(OrgRole.Member);
    stubMemberKeys({ permissions: undefined });

    const result = await handler(roleEvent(OrgRole.Admin), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(mockDeleteAccessKey).not.toHaveBeenCalled();
    expect(
      ddbMock
        .commandCalls(QueryCommand)
        .filter((call) => call.args[0].input.TableName === 'UserInfoTable'),
    ).toHaveLength(0);
  });

  it('emails the member the keys that stopped working', async () => {
    // Email goes out on the two stages that hold a SendGrid credential.
    process.env.FILONE_STAGE = Stage.Production;
    mockFetch.mockResolvedValue(new Response('', { status: 202 }));
    stubMemberKeys({ permissions: ['read', 'DeleteBucket'] });
    ddbMock
      .on(GetItemCommand, {
        TableName: 'UserInfoTable',
        Key: { pk: { S: `USER#${TARGET_ID}` }, sk: { S: 'PROFILE' } },
      })
      .resolves({ Item: { email: { S: 'member@example.com' } } });

    await handler(roleEvent(OrgRole.Member), buildContext());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as {
      personalizations: Array<{ to: Array<{ email: string }> }>;
      subject: string;
      content: Array<{ value: string }>;
    };
    expect(sent.personalizations[0]!.to[0]!.email).toBe('member@example.com');
    expect(sent.subject).toBe('Your access keys in Acme Storage were revoked');
    expect(sent.content[0]!.value).toContain('key 0');
  });

  it('changes the role even when the member has no address to tell', async () => {
    process.env.FILONE_STAGE = Stage.Production;
    stubMemberKeys({ permissions: ['read', 'DeleteBucket'] });

    const result = await handler(roleEvent(OrgRole.Member), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
