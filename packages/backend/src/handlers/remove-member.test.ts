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

import { handler } from './remove-member.js';
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

function removeEvent(targetUserId: string | null = TARGET_ID) {
  const event = buildEvent({
    cookies: [
      `hs_access_token=valid-token`,
      `hs_id_token=id-token`,
      `hs_csrf_token=${MOCK_CSRF_TOKEN}`,
    ],
    userInfo: { userId: USER_ID, orgId: ORG_ID, email: EMAIL, membership: NO_MEMBERSHIP },
    method: 'DELETE',
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

function targetHolds(role: OrgRole | undefined, userId = TARGET_ID) {
  if (!role) {
    stubAbsentMembershipRead(ddbMock, { orgId: ORG_ID, userId });
    return;
  }
  stubMembershipRead(ddbMock, { orgId: ORG_ID, userId, role });
}

function stubTargetInvitations(count: number) {
  ddbMock
    .on(QueryCommand, {
      TableName: 'OrgTable',
      ExpressionAttributeValues: {
        ':pk': { S: OrgKeys.orgPk(ORG_ID) },
        ':skPrefix': { S: 'INVITE#' },
      },
    })
    .resolves({
      Items: Array.from({ length: count }, (_unused, index) => ({
        pk: { S: OrgKeys.orgPk(ORG_ID) },
        sk: { S: OrgKeys.inviteSk(`invite-${index}`) },
        email: { S: `person-${index}@example.com` },
        emailNorm: { S: `person-${index}@example.com` },
        role: { S: OrgRole.Member },
        invitedBy: { S: TARGET_ID },
        status: { S: 'pending' },
        createdAt: { S: '2026-08-14T00:00:00.000Z' },
        expiresAt: { S: inviteExpiresAt(new Date().toISOString()) },
        tokenHash: { S: `${index}`.repeat(64).slice(0, 64) },
      })),
    });
}

function transactItems() {
  const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
  expect(calls).toHaveLength(1);
  return calls[0].args[0].input.TransactItems ?? [];
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

describe('DELETE /api/org/members/{userId} handler', () => {
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
    stubTargetInvitations(0);
    callerHolds(OrgRole.Owner);
    targetHolds(OrgRole.Member);
  });

  it('removes both membership rows', async () => {
    const result = await handler(removeEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 204 });
    const items = transactItems();
    expect(items).toHaveLength(3);
    expect(items[0].Delete).toMatchObject({
      Key: { pk: { S: OrgKeys.orgPk(ORG_ID) }, sk: { S: OrgKeys.memberSk(TARGET_ID) } },
      // Removing somebody already gone is a clean 404, not a silent success.
      ConditionExpression: 'attribute_exists(pk)',
    });
    expect(items[1].Delete).toMatchObject({
      Key: { pk: { S: OrgKeys.userPk(TARGET_ID) }, sk: { S: OrgKeys.membershipSk(ORG_ID) } },
    });
  });

  it('records the removal with no secret in it', async () => {
    await handler(removeEvent(), buildContext());

    expect(unmarshall(auditItemIn(transactItems()))).toMatchObject({
      type: 'member.removed',
      orgId: ORG_ID,
      subject: `user:${TARGET_ID}`,
      actor: { kind: 'user', id: USER_ID, email: EMAIL },
      details: { role: OrgRole.Member },
    });
    expectNoSecrets(auditItemIn(transactItems()));
  });

  it('lowers the owner count, guarded, when the member was an Owner', async () => {
    targetHolds(OrgRole.Owner);

    await handler(removeEvent(), buildContext());

    expect(
      transactItems().find((item) => item.Update?.Key?.sk?.S === 'META')!.Update,
    ).toMatchObject({
      UpdateExpression: 'SET ownerCount = ownerCount - :one',
      ConditionExpression: 'ownerCount > :one',
    });
  });

  it('refuses an Admin removing an Owner', async () => {
    // Removal counts against the same ceiling as demotion, otherwise deleting
    // an Owner would reach what demoting one forbids.
    callerHolds(OrgRole.Admin);
    targetHolds(OrgRole.Owner);

    const result = await handler(removeEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 403 });
    expect(body(result).code).toBe(ApiErrorCode.FORBIDDEN_ROLE);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('refuses to remove the last Owner', async () => {
    targetHolds(OrgRole.Owner);
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt(2, 4));

    const result = await handler(removeEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 409 });
    expect(body(result).code).toBe(ApiErrorCode.LAST_OWNER);
  });

  it('lets an Admin remove themselves', async () => {
    // Self-removal is "leave this organization", and it goes through the same
    // rules rather than a second endpoint.
    callerHolds(OrgRole.Admin);
    targetHolds(OrgRole.Admin, USER_ID);

    const result = await handler(removeEvent(USER_ID), buildContext());

    expect(result).toMatchObject({ statusCode: 204 });
  });

  it('refuses a Member trying to leave, because the matrix grants them no removal', async () => {
    // Not an oversight in this handler: `members.manage` is what the route
    // costs, a Member does not hold it, and "leave this organization" for a
    // Member or ReadOnly is a product decision the M1 matrix does not make.
    callerHolds(OrgRole.Member);
    targetHolds(OrgRole.Member, USER_ID);

    const result = await handler(removeEvent(USER_ID), buildContext());

    expect(result).toMatchObject({ statusCode: 403 });
    expect(body(result).code).toBe(ApiErrorCode.FORBIDDEN_ROLE);
  });

  it('stops the last Owner leaving by the same guard', async () => {
    callerHolds(OrgRole.Owner);
    targetHolds(OrgRole.Owner, USER_ID);
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt(2, 4));

    const result = await handler(removeEvent(USER_ID), buildContext());

    expect(result).toMatchObject({ statusCode: 409 });
    expect(body(result).code).toBe(ApiErrorCode.LAST_OWNER);
  });

  it('revokes every invitation the departing member issued', async () => {
    stubTargetInvitations(2);

    await handler(removeEvent(), buildContext());

    const items = transactItems();
    expect(
      items.filter((item) => item.Update?.UpdateExpression === 'SET #status = :status'),
    ).toHaveLength(2);
    // Two status updates, two token deletes, plus the membership pair.
    expect(items.filter((item) => item.Delete)).toHaveLength(4);
    expect(unmarshall(auditItemIn(items)).details).toMatchObject({ revokedInvitations: 2 });
  });

  it('returns 404 for somebody who is not a member', async () => {
    targetHolds(undefined);

    const result = await handler(removeEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 404 });
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('returns 404 when somebody else removed them first', async () => {
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelledAt(0, 3));

    const result = await handler(removeEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('leaves the member’s keys alone', async () => {
    // M1 removes the membership and nothing else; the console names the keys in
    // its confirmation dialog and FIL-1021 adds the revoke-by-default flow.
    await handler(removeEvent(), buildContext());

    const written = JSON.stringify(transactItems());
    expect(written).not.toContain('ACCESSKEY');
    expect(written).not.toContain('RAGKEY');
  });

  it('returns 400 with no member id in the path', async () => {
    const result = await handler(removeEvent(null), buildContext());

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
      return handler(removeEvent(), buildContext());
    },
  });
});
