import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { ApiErrorCode, OrgRole } from '@filone/shared';
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

const ddbMock = mockClient(DynamoDBClient);

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
import { describeRoleEnforcement } from '../test/role-enforcement.js';

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
    stubOwnerCount(1);
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
    // canonical, inverse, event — the owner set did not move.
    expect(items).toHaveLength(3);
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
      UpdateExpression: 'SET ownerCount = ownerCount + :one',
      ConditionExpression: 'attribute_exists(ownerCount)',
    });
  });

  it('guards the decrement with the condition that is the last-Owner invariant', async () => {
    targetHolds(OrgRole.Owner);

    const result = await handler(roleEvent(OrgRole.Admin), buildContext());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(counterItem()).toMatchObject({
      UpdateExpression: 'SET ownerCount = ownerCount - :one',
      // DynamoDB permits one operation per item per transaction, so the check
      // and the decrement have to be the same operation.
      ConditionExpression: 'ownerCount > :one',
    });
  });

  it('refuses to demote the last Owner', async () => {
    targetHolds(OrgRole.Owner);
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt(2, 4));

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
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt(2, 4));

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
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt(0, 3));

    const result = await handler(roleEvent(OrgRole.Admin), buildContext());

    expect(result).toMatchObject({ statusCode: 409 });
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

  describeRoleEnforcement({
    permission: 'members.manage',
    orgId: ORG_ID,
    userId: USER_ID,
    invoke: (membership) => {
      if (membership === NO_MEMBERSHIP) {
        stubAbsentMembershipRead(ddbMock, { orgId: ORG_ID, userId: USER_ID });
      } else {
        callerHolds(membership.role);
      }
      return handler(roleEvent(OrgRole.Admin), buildContext());
    },
  });
});
